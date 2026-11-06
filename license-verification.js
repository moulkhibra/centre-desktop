"use strict";

/**
 * Centre offline license verification (Phase 1).
 *
 * This module is intentionally pure: it performs no file, network, Electron,
 * or user-data access. The caller supplies the serialized license and the
 * trusted Ed25519 public key.
 *
 * Envelope (UTF-8 JSON object):
 * {
 *   "schema": "centre-license/1",
 *   "alg": "Ed25519",
 *   "keyId": "centre-2026-01",
 *   "payload": "<base64url of the exact UTF-8 payload bytes>",
 *   "signature": "<base64url of the 64-byte Ed25519 signature>"
 * }
 *
 * Payload (UTF-8 JSON object, signed as exact bytes):
 * {
 *   "product": "ma.centre.app",
 *   "licenseId": "0f2c8b1e-...",
 *   "licensee": "Centre ...",
 *   "issuedAt": "2026-11-04",
 *   "notBefore": "2026-11-04",   // optional, may be null
 *   "type": "perpetual",
 *   "device": null               // reserved for Phase 2
 * }
 *
 * Rules:
 * - Dates are calendar dates in YYYY-MM-DD form, interpreted as UTC dates.
 * - `notBefore` is optional. When present, the license is not valid before
 *   that UTC date.
 * - Licenses are perpetual in Phase 1. Expiration is not interpreted.
 * - `device` must be present, but its contents are not interpreted yet.
 *   Device fingerprinting, matching, storage, activation UI, and key
 *   selection are deferred to later phases.
 * - Unknown payload fields are allowed and ignored so a valid license can
 *   carry future metadata. Unknown fields are still covered by the signature.
 *
 * The signature is verified over the decoded payload bytes before the
 * payload JSON is parsed or trusted.
 */

const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const LICENSE_SCHEMA = "centre-license/1";
const LICENSE_ALGORITHM = "Ed25519";
const PRODUCT_ID = "ma.centre.app";
const LICENSE_TYPE_PERPETUAL = "perpetual";

const MAX_LICENSE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_PAYLOAD_CHARS = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 8;
const MAX_SIGNATURE_CHARS = 128;
const MAX_LICENSE_ID_LENGTH = 128;
const MAX_LICENSEE_LENGTH = 256;
const MAX_KEY_ID_LENGTH = 64;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const LICENSE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function fail(code, error) {
  return { ok: false, code: code, error: error };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidDateOnly(value) {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function utcDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function normalizeNow(value) {
  if (value === undefined) return new Date();
  if (value === null || value === "") return null;
  let date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    return null;
  }
  return Number.isFinite(date.getTime()) ? date : null;
}

function decodeBase64Url(value, maxChars) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > maxChars) return null;
  if (!BASE64URL_RE.test(value)) return null;
  let buffer;
  try {
    buffer = Buffer.from(value, "base64url");
  } catch (error) {
    return null;
  }
  if (buffer.length === 0) return null;
  if (buffer.toString("base64url") !== value) return null;
  return buffer;
}

function resolvePublicKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value.type && value.type !== "public") return null;

  // Do not accept a private key by accident. Only public keys belong here.
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    try {
      crypto.createPrivateKey(value);
      return null;
    } catch (error) {
      // Expected for public keys.
    }
  }

  let key;
  try {
    if (Buffer.isBuffer(value)) {
      try {
        key = crypto.createPublicKey({ key: value, format: "der", type: "spki" });
      } catch (derError) {
        key = crypto.createPublicKey(value);
      }
    } else {
      key = value && value.type === "public" ? value : crypto.createPublicKey(value);
    }
  } catch (error) {
    return null;
  }
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
  return key;
}

function readEnvelope(input) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_LICENSE_BYTES) {
      return fail("TOO_LARGE", "License data is too large.");
    }
    try {
      input = JSON.parse(input);
    } catch (error) {
      return fail("MALFORMED_ENVELOPE", "License envelope is not valid JSON.");
    }
  }
  if (!isPlainObject(input)) {
    return fail("MALFORMED_ENVELOPE", "License envelope must be a JSON object.");
  }
  return { ok: true, data: input };
}

function parsePayload(payloadBytes) {
  let text;
  try {
    text = utf8Decoder.decode(payloadBytes);
  } catch (error) {
    return fail("MALFORMED_PAYLOAD", "License payload is not valid UTF-8.");
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return fail("MALFORMED_PAYLOAD", "License payload is not valid JSON.");
  }
  if (!isPlainObject(payload)) {
    return fail("MALFORMED_PAYLOAD", "License payload must be a JSON object.");
  }
  return { ok: true, data: payload };
}

function validatePayload(payload, nowDate) {
  if (!hasOwn(payload, "product") || typeof payload.product !== "string") {
    return fail("MALFORMED_PAYLOAD", "License payload is missing a valid product.");
  }
  if (payload.product !== PRODUCT_ID) {
    return fail("PRODUCT_MISMATCH", "License product does not match " + PRODUCT_ID + ".");
  }

  if (
    !hasOwn(payload, "licenseId") ||
    typeof payload.licenseId !== "string" ||
    payload.licenseId.length > MAX_LICENSE_ID_LENGTH ||
    !LICENSE_ID_RE.test(payload.licenseId)
  ) {
    return fail("INVALID_LICENSE_ID", "License ID is missing or has an invalid format.");
  }

  if (!hasOwn(payload, "licensee") || typeof payload.licensee !== "string") {
    return fail("INVALID_LICENSEE", "Licensee is missing.");
  }
  if (payload.licensee.length > MAX_LICENSEE_LENGTH) {
    return fail("INVALID_LICENSEE", "Licensee is too long.");
  }
  if (payload.licensee.trim() === "") {
    return fail("INVALID_LICENSEE", "Licensee must not be empty.");
  }
  if (CONTROL_CHAR_RE.test(payload.licensee)) {
    return fail("INVALID_LICENSEE", "Licensee contains invalid control characters.");
  }

  if (!hasOwn(payload, "issuedAt") || !isValidDateOnly(payload.issuedAt)) {
    return fail("INVALID_ISSUED_AT", "Issue date must be a valid YYYY-MM-DD date.");
  }

  let notBefore = null;
  if (hasOwn(payload, "notBefore") && payload.notBefore !== null && payload.notBefore !== undefined) {
    if (!isValidDateOnly(payload.notBefore)) {
      return fail("INVALID_NOT_BEFORE", "Not-before date must be a valid YYYY-MM-DD date.");
    }
    notBefore = payload.notBefore;
  }

  if (!hasOwn(payload, "type") || typeof payload.type !== "string") {
    return fail("MALFORMED_PAYLOAD", "License payload is missing a license type.");
  }
  if (payload.type !== LICENSE_TYPE_PERPETUAL) {
    return fail("UNSUPPORTED_LICENSE_TYPE", "Only perpetual licenses are supported.");
  }

  if (!hasOwn(payload, "device")) {
    return fail("MALFORMED_PAYLOAD", "License payload is missing the device field.");
  }
  if (payload.device !== null && !isPlainObject(payload.device)) {
    return fail("MALFORMED_PAYLOAD", "Device field must be null or an object.");
  }

  const today = utcDateString(nowDate);
  if (notBefore !== null && notBefore > today) {
    return fail("NOT_YET_VALID", "License is not valid before " + notBefore + ".");
  }

  return { ok: true, data: payload };
}

/**
 * Verify a Centre license envelope.
 *
 * @param {object|string} input Parsed envelope object or its UTF-8 JSON text.
 * @param {object} options
 * @param {crypto.KeyObject|string|Buffer|object} options.publicKey Trusted
 *   Ed25519 public key. PEM, DER, or a KeyObject are accepted.
 * @param {Date|number|string} [options.now] Clock value for not-before checks.
 *   Defaults to the current time. Tests should inject a fixed value.
 * @param {string} [options.expectedKeyId] Optional expected envelope key ID.
 * @returns {{ok: true, data: object}|{ok: false, code: string, error: string}}
 */
function verifyLicense(input, options) {
  const opts = options && typeof options === "object" ? options : {};
  const nowDate = normalizeNow(opts.now);
  if (!nowDate) {
    return fail("INVALID_OPTIONS", "now must be a valid date.");
  }
  if (
    opts.expectedKeyId !== undefined &&
    (typeof opts.expectedKeyId !== "string" || opts.expectedKeyId.length === 0)
  ) {
    return fail("INVALID_OPTIONS", "expectedKeyId must be a non-empty string.");
  }

  const publicKey = resolvePublicKey(opts.publicKey);
  if (!publicKey) {
    return fail("INVALID_PUBLIC_KEY", "A valid Ed25519 public key is required.");
  }

  const envelopeResult = readEnvelope(input);
  if (!envelopeResult.ok) return envelopeResult;
  const envelope = envelopeResult.data;

  if (envelope.schema !== LICENSE_SCHEMA) {
    return fail("UNSUPPORTED_SCHEMA", "License schema is not supported.");
  }
  if (envelope.alg !== LICENSE_ALGORITHM) {
    return fail("UNSUPPORTED_ALGORITHM", "License signature algorithm is not supported.");
  }
  if (
    typeof envelope.keyId !== "string" ||
    envelope.keyId.length > MAX_KEY_ID_LENGTH ||
    !KEY_ID_RE.test(envelope.keyId)
  ) {
    return fail("MALFORMED_ENVELOPE", "License key ID is missing or has an invalid format.");
  }
  if (opts.expectedKeyId !== undefined && envelope.keyId !== opts.expectedKeyId) {
    return fail("KEY_ID_MISMATCH", "License key ID does not match the expected key.");
  }

  const payloadBytes = decodeBase64Url(envelope.payload, MAX_PAYLOAD_CHARS);
  if (!payloadBytes) {
    return fail("MALFORMED_ENVELOPE", "License payload is not valid base64url.");
  }
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    return fail("PAYLOAD_TOO_LARGE", "License payload is too large.");
  }

  const signatureBytes = decodeBase64Url(envelope.signature, MAX_SIGNATURE_CHARS);
  if (!signatureBytes) {
    return fail("MALFORMED_SIGNATURE", "License signature is not valid base64url.");
  }
  if (signatureBytes.length !== 64) {
    return fail("MALFORMED_SIGNATURE", "License signature must be 64 bytes.");
  }

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(null, payloadBytes, publicKey, signatureBytes);
  } catch (error) {
    signatureValid = false;
  }
  if (!signatureValid) {
    return fail("INVALID_SIGNATURE", "License signature is invalid.");
  }

  const payloadResult = parsePayload(payloadBytes);
  if (!payloadResult.ok) return payloadResult;

  return validatePayload(payloadResult.data, nowDate);
}

module.exports = {
  LICENSE_SCHEMA: LICENSE_SCHEMA,
  LICENSE_ALGORITHM: LICENSE_ALGORITHM,
  PRODUCT_ID: PRODUCT_ID,
  LICENSE_TYPE_PERPETUAL: LICENSE_TYPE_PERPETUAL,
  MAX_LICENSE_BYTES: MAX_LICENSE_BYTES,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  verifyLicense: verifyLicense,
};
