"use strict";

/**
 * Centre runtime production trust anchor (used by the Phase 4B startup gate).
 *
 * This module is the ONLY place the application may obtain trusted license
 * public keys. It contains hardcoded **public** Ed25519 keys and nothing else.
 *
 * It must never:
 * - read keys from user data, environment variables, a config file, the
 *   license envelope, the renderer, or the network,
 * - contain a private key, a `*.pem` private key, or signing material,
 * - generate keys.
 *
 * PRODUCTION KEY PLACEHOLDER
 * --------------------------
 * `PRODUCTION_PUBLIC_KEYS` is intentionally empty. The application MUST fail
 * closed until the owner replaces this placeholder with the real Ed25519
 * public key(s) from the offline signing machine, for example:
 *
 *   { keyId: "centre-2026-01", publicKey: "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" }
 *
 * Only `createProductionTrustedKeyRegistry()` may be used by application
 * startup. It returns `PRODUCTION_KEY_NOT_CONFIGURED` while the array is empty
 * or while any configured entry is not a valid Ed25519 public key.
 */

const { createTrustedKeyRegistry } = require("./license-activation");

const PRODUCTION_PUBLIC_KEYS = Object.freeze([
  // OWNER: replace this empty placeholder with real public key entries.
  // Never add private keys or signing material here.
]);

/**
 * Build the runtime trusted-key registry from the hardcoded public keys.
 *
 * @returns {{ok: true, data: object}|{ok: false, code: string, error: string, cause?: string}}
 */
function createProductionTrustedKeyRegistry() {
  if (!Array.isArray(PRODUCTION_PUBLIC_KEYS) || PRODUCTION_PUBLIC_KEYS.length === 0) {
    return {
      ok: false,
      code: "PRODUCTION_KEY_NOT_CONFIGURED",
      error:
        "No production trusted public key is configured. The application must fail closed.",
    };
  }

  const result = createTrustedKeyRegistry(PRODUCTION_PUBLIC_KEYS);
  if (!result.ok) {
    return {
      ok: false,
      code: "PRODUCTION_KEY_NOT_CONFIGURED",
      error:
        "Production trusted public keys are invalid. The application must fail closed.",
      cause: result.code,
    };
  }

  return result;
}

module.exports = {
  PRODUCTION_PUBLIC_KEYS: PRODUCTION_PUBLIC_KEYS,
  createProductionTrustedKeyRegistry: createProductionTrustedKeyRegistry,
};
