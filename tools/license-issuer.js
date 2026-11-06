"use strict";

/**
 * Centre owner-side offline license issuance (Phase 3B).
 *
 * This module is NOT part of the application runtime. It must be kept on the
 * owner's offline signing machine and must never be shipped with the
 * application, embedded in Electron, or committed with a production key.
 *
 * The issuer:
 * - accepts an Ed25519 private key supplied by the caller at runtime,
 * - accepts a public device binding produced by `device-fingerprint.js`,
 * - builds the Phase 1 payload,
 * - signs the exact UTF-8 payload bytes with Ed25519,
 * - self-verifies the resulting envelope with the derived public key.
 *
 * The private key is used only in memory. It is never returned, serialized,
 * logged, or written anywhere by this module. No key generation is performed
 * here. Tests use temporary in-memory Ed25519 keys only.
 *
 * The device binding must contain only the hashed identifiers produced by
 * Phase 2. Raw hardware identifiers are rejected, and any extra binding
 * metadata is dropped so it cannot accidentally enter the signed payload.
 */

const crypto = require("node:crypto");
const {
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
  LICENSE_TYPE_PERPETUAL,
  verifyLicense,
} = require("../license-verification");
const {
  DEVICE_SCHEME,
  REQUIRED_IDENTIFIERS,
  SUPPORTED_IDENTIFIERS,
  isPlaceholderSmbiosHash,
} = require("../device-fingerprint");

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPPORTED_SET = new Set(SUPPORTED_IDENTIFIERS);

function fail(code, error, identifier) {
  const result = { ok: false, code: code, error: error };
  if (identifier) result.identifier = identifier;
  return result;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolvePrivateKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value.type && value.type !== "private") return null;

  let key;
  try {
    if (value && value.type === "private") {
      key = value;
    } else {
      try {
        key = crypto.createPrivateKey(value);
      } catch (pemError) {
        if (!Buffer.isBuffer(value)) throw pemError;
        key = crypto.createPrivateKey({ key: value, format: "der", type: "pkcs8" });
      }
    }
  } catch (error) {
    return null;
  }
  if (!key || key.type !== "private" || key.asymmetricKeyType !== "ed25519") return null;
  return key;
}

function normalizeDeviceBinding(binding) {
  if (!isPlainObject(binding)) {
    return fail("INVALID_DEVICE_BINDING", "Device binding must be an object.");
  }
  if (binding.scheme !== DEVICE_SCHEME) {
    return fail("INVALID_DEVICE_BINDING", "Device binding scheme is not supported.");
  }
  if (binding.match !== "all") {
    return fail("INVALID_DEVICE_BINDING", "Device binding must require all identifiers.");
  }
  if (!isPlainObject(binding.identifiers)) {
    return fail("INVALID_DEVICE_BINDING", "Device binding identifiers must be an object.");
  }

  const names = Object.keys(binding.identifiers);
  if (names.length === 0) {
    return fail("INVALID_DEVICE_BINDING", "Device binding must select at least one identifier.");
  }
  for (const name of names) {
    if (!SUPPORTED_SET.has(name)) {
      return fail(
        "INVALID_DEVICE_BINDING",
        "Device binding contains an unsupported identifier.",
        name
      );
    }
  }
  for (const required of REQUIRED_IDENTIFIERS) {
    if (!hasOwn(binding.identifiers, required)) {
      return fail(
        "INVALID_DEVICE_BINDING",
        "A standard device binding must include machineGuid and smbiosUuid.",
        required
      );
    }
  }
  if (isPlaceholderSmbiosHash(binding.identifiers.smbiosUuid)) {
    return fail(
      "INVALID_DEVICE_BINDING",
      "Device binding uses a placeholder SMBIOS UUID.",
      "smbiosUuid"
    );
  }

  // Canonical order and known fields only. Extra top-level binding metadata is
  // deliberately dropped so no raw values or unrelated fields can be signed.
  const identifiers = {};
  for (const name of SUPPORTED_IDENTIFIERS) {
    if (!hasOwn(binding.identifiers, name)) continue;
    const hash = binding.identifiers[name];
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      return fail(
        "INVALID_DEVICE_BINDING",
        "Device binding contains an invalid identifier hash.",
        name
      );
    }
    identifiers[name] = hash;
  }

  if (Object.keys(identifiers).length === 0) {
    return fail("INVALID_DEVICE_BINDING", "Device binding must select at least one identifier.");
  }

  return {
    ok: true,
    data: {
      scheme: DEVICE_SCHEME,
      match: "all",
      identifiers: identifiers,
    },
  };
}

function utcDateString(date) {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

/**
 * Issue a device-bound perpetual license envelope.
 *
 * @param {object} options
 * @param {crypto.KeyObject|string|Buffer} options.privateKey Ed25519 private
 *   key supplied by the owner at runtime. Never embedded in the app.
 * @param {string} options.keyId Key ID that the target app's trusted registry
 *   will use to select the corresponding public key.
 * @param {object} options.deviceBinding Public device binding from Phase 2.
 * @param {string} options.licenseId Unique owner-assigned license ID.
 * @param {string} options.licensee Licensee name.
 * @param {string} [options.issuedAt] UTC `YYYY-MM-DD`; defaults to today.
 * @param {string|null} [options.notBefore] Optional UTC `YYYY-MM-DD`.
 * @returns {{ok: true, data: object}|{ok: false, code: string, error: string}}
 */
function issueLicense(options) {
  const opts = options && typeof options === "object" ? options : {};

  const privateKey = resolvePrivateKey(opts.privateKey);
  if (!privateKey) {
    return fail("INVALID_PRIVATE_KEY", "A valid Ed25519 private key is required.");
  }

  if (typeof opts.keyId !== "string" || !KEY_ID_RE.test(opts.keyId)) {
    return fail("INVALID_KEY_ID", "A valid key ID is required.");
  }
  if (typeof opts.licenseId !== "string" || opts.licenseId.trim() === "") {
    return fail("INVALID_OPTIONS", "A license ID is required.");
  }
  if (typeof opts.licensee !== "string" || opts.licensee.trim() === "") {
    return fail("INVALID_OPTIONS", "A licensee name is required.");
  }

  const binding = normalizeDeviceBinding(opts.deviceBinding);
  if (!binding.ok) return binding;

  const issuedAt =
    opts.issuedAt === undefined ? utcDateString(new Date()) : opts.issuedAt;

  const payload = {
    product: PRODUCT_ID,
    licenseId: opts.licenseId,
    licensee: opts.licensee,
    issuedAt: issuedAt,
    type: LICENSE_TYPE_PERPETUAL,
    device: binding.data,
  };
  if (hasOwn(opts, "notBefore")) payload.notBefore = opts.notBefore;

  let payloadBytes;
  try {
    payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  } catch (error) {
    return fail("INVALID_OPTIONS", "License payload could not be serialized.");
  }

  let signature;
  try {
    signature = crypto.sign(null, payloadBytes, privateKey);
  } catch (error) {
    return fail("INVALID_PRIVATE_KEY", "License could not be signed with the supplied key.");
  }

  const envelope = {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: opts.keyId,
    payload: payloadBytes.toString("base64url"),
    signature: signature.toString("base64url"),
  };

  // Self-check the exact envelope against the derived public key. A far-future
  // clock keeps an intentionally future `notBefore` from blocking issuance.
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(privateKey);
  } catch (error) {
    return fail("INVALID_PRIVATE_KEY", "A public key could not be derived from the private key.");
  }

  const selfCheck = verifyLicense(envelope, { publicKey: publicKey, now: "9999-12-31" });
  if (!selfCheck.ok) {
    return fail(selfCheck.code, selfCheck.error);
  }

  return { ok: true, data: envelope };
}

module.exports = {
  issueLicense: issueLicense,
};
