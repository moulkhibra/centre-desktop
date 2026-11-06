"use strict";

/**
 * Centre offline license activation (Phase 3A).
 *
 * This module is a pure integration layer. It:
 *   1. selects a trusted Ed25519 public key by the envelope's `keyId`,
 *   2. verifies the signed license with `license-verification.js`,
 *   3. requires the signed payload to contain a non-null device binding,
 *   4. strictly matches that binding against injected current identifiers
 *      using `device-fingerprint.js`.
 *
 * The device binding lives inside the signed payload, so it is covered by the
 * Ed25519 signature. Changing any part of the binding invalidates the
 * signature before device matching is ever attempted.
 *
 * This module performs no filesystem, network, Electron, storage, logging, or
 * UI work. Current device identifiers are supplied by the caller; Windows
 * collection is intentionally kept outside this layer.
 *
 * A license with `device: null` is a valid Phase 1 license but is NOT a valid
 * activated production license. This module rejects it with `DEVICE_REQUIRED`.
 *
 * Trusted keys are supplied by the caller at runtime. No production key is
 * embedded in this file, and this module never generates keys or licenses.
 */

const crypto = require("node:crypto");
const { MAX_LICENSE_BYTES, verifyLicense } = require("./license-verification");
const {
  matchDeviceBinding,
  validateDeviceBinding,
} = require("./device-fingerprint");

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Only registries actually built by createTrustedKeyRegistry are accepted.
// A plain object that happens to expose has/get methods cannot masquerade as a
// trust anchor.
const TRUSTED_REGISTRIES = new WeakSet();

function isTrustedKeyRegistry(value) {
  return Boolean(value && typeof value === "object" && TRUSTED_REGISTRIES.has(value));
}

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

function resolveTrustedPublicKey(value) {
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

/**
 * Build a trusted-key registry keyed by `keyId`.
 *
 * Accepted entry forms:
 *   - array: [{ keyId: "centre-2026-01", publicKey: <PEM|DER|KeyObject> }]
 *   - object map: { "centre-2026-01": <PEM|DER|KeyObject> }
 *   - Map: new Map([["centre-2026-01", <PEM|DER|KeyObject>]])
 *
 * Every key is validated as an Ed25519 public key. Private keys, non-Ed25519
 * keys, malformed key IDs, duplicate key IDs, and empty registries are
 * rejected. The registry is immutable from the caller's perspective and is
 * the only source of trusted keys used during activation.
 *
 * @returns {{ok: true, data: object}|{ok: false, code: string, error: string}}
 */
function createTrustedKeyRegistry(entries) {
  const pairs = [];

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (
        !isPlainObject(entry) ||
        !hasOwn(entry, "keyId") ||
        !hasOwn(entry, "publicKey")
      ) {
        return fail(
          "INVALID_KEY_REGISTRY",
          "Each key registry entry must contain keyId and publicKey."
        );
      }
      pairs.push([entry.keyId, entry.publicKey]);
    }
  } else if (entries instanceof Map) {
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        return fail(
          "INVALID_KEY_REGISTRY",
          "Each key registry Map entry must contain a key ID and public key."
        );
      }
      pairs.push([pair[0], pair[1]]);
    }
  } else if (isPlainObject(entries)) {
    for (const keyId of Object.keys(entries)) {
      pairs.push([keyId, entries[keyId]]);
    }
  } else {
    return fail(
      "INVALID_KEY_REGISTRY",
      "Key registry entries must be an array, object, or Map."
    );
  }

  if (pairs.length === 0) {
    return fail("INVALID_KEY_REGISTRY", "Key registry must contain at least one trusted key.");
  }

  const keys = new Map();
  for (const pair of pairs) {
    const keyId = pair[0];
    if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) {
      return fail("INVALID_KEY_REGISTRY", "Key registry contains an invalid key ID.");
    }
    if (keys.has(keyId)) {
      return fail("INVALID_KEY_REGISTRY", "Key registry contains duplicate key IDs.");
    }

    const publicKey = resolveTrustedPublicKey(pair[1]);
    if (!publicKey) {
      return fail(
        "INVALID_KEY_REGISTRY",
        "Key registry contains an invalid Ed25519 public key."
      );
    }
    keys.set(keyId, publicKey);
  }

  const registry = {
    has(keyId) {
      return typeof keyId === "string" && keys.has(keyId);
    },
    get(keyId) {
      return typeof keyId === "string" ? keys.get(keyId) : undefined;
    },
    keyIds() {
      return Array.from(keys.keys());
    },
    get size() {
      return keys.size;
    },
  };

  const frozenRegistry = Object.freeze(registry);
  TRUSTED_REGISTRIES.add(frozenRegistry);
  return { ok: true, data: frozenRegistry };
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

/**
 * Verify a license envelope cryptographically and require a valid, complete
 * signed device binding, without matching it against the current device.
 *
 * This is the first half of activation. It is used when the identifiers to
 * collect are not known until the signed binding has been read and verified:
 * the envelope signature and binding structure are validated before any
 * binding field is trusted or any device identifier is collected.
 *
 * @param {object|string} input Parsed envelope or UTF-8 JSON text.
 * @param {object} options
 * @param {object} options.registry Trusted key registry from
 *   `createTrustedKeyRegistry`.
 * @param {Date|number|string} [options.now] Clock value for not-before checks.
 * @returns {{ok: true, data: object, identifiers: string[]}|{ok: false, code: string, error: string}}
 *   On success, `data` is the verified payload and `identifiers` is the sorted
 *   list of identifier names present in the signed binding.
 */
function verifyActivatedLicenseSignature(input, options) {
  const opts = options && typeof options === "object" ? options : {};
  const registry = opts.registry;

  if (!isTrustedKeyRegistry(registry)) {
    return fail(
      "INVALID_OPTIONS",
      "A trusted key registry created by createTrustedKeyRegistry is required."
    );
  }

  const envelopeResult = readEnvelope(input);
  if (!envelopeResult.ok) return envelopeResult;
  const envelope = envelopeResult.data;

  const keyId = envelope.keyId;
  if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) {
    return fail("MALFORMED_ENVELOPE", "License key ID is missing or has an invalid format.");
  }
  if (!registry.has(keyId)) {
    return fail("UNKNOWN_KEY_ID", "License key ID is not trusted.");
  }

  const verified = verifyLicense(envelope, {
    publicKey: registry.get(keyId),
    now: opts.now,
    expectedKeyId: keyId,
  });
  if (!verified.ok) return verified;

  const payload = verified.data;

  // A Phase 1 license may carry `device: null`, but that is not an activated
  // production license. This check runs only after the signature is verified.
  if (payload.device === null || payload.device === undefined) {
    return fail("DEVICE_REQUIRED", "A production license must be bound to a device.");
  }

  // Validate the signed binding before any caller trusts its identifier names.
  // This rejects incomplete/weaker bindings, unknown identifiers, placeholder
  // SMBIOS hashes, and non-canonical hashes.
  const binding = validateDeviceBinding(payload.device);
  if (!binding.ok) return binding;

  return {
    ok: true,
    data: payload,
    identifiers: Object.keys(binding.data.identifiers).sort(),
  };
}

/**
 * Verify a license and require it to be bound to the current device.
 *
 * @param {object|string} input Parsed envelope or UTF-8 JSON text.
 * @param {object} options
 * @param {object} options.registry Trusted key registry from
 *   `createTrustedKeyRegistry`.
 * @param {object} options.deviceIdentifiers Current raw device identifiers,
 *   for example `{ machineGuid, smbiosUuid }`. Injection keeps tests and
 *   non-Windows callers hardware-free.
 * @param {Date|number|string} [options.now] Clock value for not-before checks.
 * @returns {{ok: true, data: object}|{ok: false, code: string, error: string}}
 */
function verifyActivatedLicense(input, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (!isPlainObject(opts.deviceIdentifiers)) {
    return fail(
      "INVALID_OPTIONS",
      "Current device identifiers must be provided as an object."
    );
  }

  const verified = verifyActivatedLicenseSignature(input, opts);
  if (!verified.ok) return verified;

  const matched = matchDeviceBinding(verified.data.device, opts.deviceIdentifiers);
  if (!matched.ok) return matched;

  return { ok: true, data: verified.data };
}

module.exports = {
  createTrustedKeyRegistry: createTrustedKeyRegistry,
  verifyActivatedLicenseSignature: verifyActivatedLicenseSignature,
  verifyActivatedLicense: verifyActivatedLicense,
};
