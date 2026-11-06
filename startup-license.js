"use strict";

/**
 * Phase 4B startup license gate.
 *
 * This module performs the complete pre-startup license check:
 *   1. validate the supplied paths,
 *   2. resolve the dedicated license directory against the real protected data
 *      directory (no directory creation),
 *   3. obtain the immutable production trusted-key registry,
 *   4. read the stored envelope and cryptographically verify it before trusting
 *      its signed device binding,
 *   5. collect exactly the identifiers named by that verified binding,
 *   6. strictly device-match the binding and return the verified payload.
 *
 * It is deliberately separate from `main.js` so the gate can be tested with
 * temporary directories and injected dependencies without launching Electron.
 *
 * The module never creates `dataDir`, the license directory, or `backups/`.
 * It never reads or writes the protected data directory.
 */

const path = require("node:path");
const { resolveLicenseStorage, loadActivatedLicense } = require("./license-store");
const { createProductionTrustedKeyRegistry } = require("./trusted-keys");
const { collectWindowsIdentifiers } = require("./device-fingerprint");

function fail(code, error, identifier) {
  const result = { ok: false, code: code, error: error };
  if (identifier) result.identifier = identifier;
  return result;
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.trim() !== "" && path.isAbsolute(value);
}

/**
 * Verify the stored startup license.
 *
 * @param {object} options
 * @param {string} options.dataDir Actual protected Centre data directory.
 * @param {string} options.userDataDir Actual Electron `userData` directory.
 * @param {string} [options.storageDir] Override license directory (tests).
 * @param {string} [options.platform] Platform passed to identifier collection.
 * @param {Function} [options.registryFactory] Trusted registry factory.
 * @param {Function} [options.collectIdentifiers] Device identifier collector.
 * @param {Function} [options.loadLicense] License loader (tests).
 * @param {Date|number|string|Function} [options.now] Clock value or provider.
 * @returns {Promise<{ok: true, data: object}|{ok: false, code: string, error: string}>}
 */
async function verifyStartupLicense(options) {
  const opts = options && typeof options === "object" ? options : {};

  if (!isAbsolutePath(opts.dataDir)) {
    return fail(
      "INVALID_OPTIONS",
      "The protected data directory must be an absolute path."
    );
  }
  if (!isAbsolutePath(opts.userDataDir)) {
    return fail("INVALID_OPTIONS", "The user data directory must be an absolute path.");
  }

  const storageDir =
    typeof opts.storageDir === "string" && opts.storageDir.trim() !== ""
      ? opts.storageDir
      : path.join(opts.userDataDir, "license");

  // Validate isolation before touching any identifier or license operation.
  const resolved = resolveLicenseStorage(storageDir, {
    protectedDataDir: opts.dataDir,
  });
  if (!resolved.ok) return resolved;

  const registryFactory =
    typeof opts.registryFactory === "function"
      ? opts.registryFactory
      : createProductionTrustedKeyRegistry;

  let registryResult;
  try {
    registryResult = registryFactory();
  } catch (error) {
    return fail(
      "PRODUCTION_KEY_NOT_CONFIGURED",
      "The production trusted-key registry is not available."
    );
  }

  if (!registryResult || registryResult.ok !== true || !registryResult.data) {
    const code =
      registryResult && typeof registryResult.code === "string"
        ? registryResult.code
        : "PRODUCTION_KEY_NOT_CONFIGURED";
    return fail(code, "No usable production trusted-key registry is configured.");
  }

  const collector =
    typeof opts.collectIdentifiers === "function"
      ? opts.collectIdentifiers
      : collectWindowsIdentifiers;

  const loader =
    typeof opts.loadLicense === "function" ? opts.loadLicense : loadActivatedLicense;
  const now = typeof opts.now === "function" ? opts.now() : opts.now;

  let loaded;
  try {
    // The loader reads and verifies the envelope before invoking the collector,
    // so only identifiers named by the signed binding are ever collected.
    loaded = await loader({
      storageDir: resolved.data.directory,
      protectedDataDir: opts.dataDir,
      registry: registryResult.data,
      collectIdentifiers: collector,
      platform: opts.platform,
      now: now,
    });
  } catch (error) {
    return fail("LICENSE_UNREADABLE", "The stored license could not be verified.");
  }

  if (!loaded || loaded.ok !== true) {
    return loaded || fail("LICENSE_INVALID", "The stored license is not valid.");
  }

  return {
    ok: true,
    data: {
      directory: resolved.data.directory,
      license: loaded.data,
    },
  };
}

module.exports = {
  verifyStartupLicense: verifyStartupLicense,
};
