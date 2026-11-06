"use strict";

/**
 * Centre license-file handling (Phase 3B, hardened in Phase 4A).
 *
 * This module is deliberately separate from the application's user-data store.
 * It never reads, writes, deletes, migrates, or otherwise touches the Centre
 * data directory.
 *
 * Storage design:
 * - The caller supplies an explicit, dedicated absolute license directory and
 *   the actual protected Centre data directory.
 * - Both paths are canonicalized through the nearest existing ancestor before
 *   they are compared, so symlinks, junctions, and other reparse points cannot
 *   hide an overlap with user data.
 * - The storage path must not overlap the protected data directory in either
 *   direction (same path, child, or parent).
 * - The license file is always `<storageDir>/license.json`.
 * - Writes go to a temporary file in the same directory and are renamed into
 *   place. The existing license is never deleted first. If an atomic
 *   replacement is not possible, the write fails closed and the old license
 *   remains untouched.
 * - Only the license file and its temporary sibling are ever written or
 *   removed. User data is never modified.
 * - Reading rejects symbolic-link/reparse-point license files and enforces a
 *   size limit.
 *
 * This module performs no network access, no Electron access, no logging, and
 * no writes outside the explicitly supplied license directory.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  MAX_LICENSE_BYTES,
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
} = require("./license-verification");
const {
  verifyActivatedLicense,
  verifyActivatedLicenseSignature,
} = require("./license-activation");
const { matchDeviceBinding } = require("./device-fingerprint");

const LICENSE_FILE_NAME = "license.json";
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DEVICE_CODES = new Set([
  "DEVICE_REQUIRED",
  "DEVICE_MISMATCH",
  "IDENTIFIER_UNAVAILABLE",
  "MALFORMED_DEVICE_BINDING",
  "MALFORMED_IDENTIFIERS",
]);

// O_NOFOLLOW is not available on every platform. The lstat check still runs.
const READ_ONLY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function fail(code, error, identifier) {
  const result = { ok: false, code: code, error: error };
  if (identifier) result.identifier = identifier;
  return result;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function comparisonKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function comparisonSegment(segment) {
  // Windows treats trailing dots and spaces in path components as aliases.
  const value =
    process.platform === "win32" ? segment.replace(/[. ]+$/g, "") : segment;
  return value.toLowerCase();
}

function hasCentreDataSegment(value) {
  return value
    .split(/[\\/]+/)
    .some((segment) => comparisonSegment(segment) === "centredata");
}

function isSameOrDescendant(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path through its nearest existing ancestor. Existing symlinks,
 * junctions, and reparse points are resolved by realpath; non-existent tail
 * components are appended to the resolved ancestor.
 *
 * Throws when an existing component cannot be inspected safely. It never
 * creates, reads, or writes a file.
 */
function canonicalizePath(target) {
  let current = path.resolve(target);
  const suffix = [];

  while (true) {
    let real = null;
    try {
      real = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw new Error("Cannot safely inspect license path.");
      }
    }

    if (real !== null) return path.join(real, ...suffix);

    let inspected = null;
    try {
      inspected = fs.lstatSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw new Error("Cannot safely inspect license path.");
      }
    }

    if (inspected) {
      throw new Error("Cannot safely inspect license path.");
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Cannot safely inspect license path.");
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Resolve and validate a dedicated license storage directory.
 *
 * `options.protectedDataDir` is required and must be the real Centre data
 * directory used by the application. Both paths are canonicalized and compared
 * in both directions. The check never creates the protected directory and
 * never reads inside it.
 */
function resolveLicenseStorage(storageDir, options) {
  const opts = options && typeof options === "object" ? options : {};

  if (typeof storageDir !== "string" || storageDir.trim() === "") {
    return fail("INVALID_OPTIONS", "A dedicated license storage directory is required.");
  }
  if (!path.isAbsolute(storageDir)) {
    return fail("UNSAFE_LICENSE_STORAGE", "License storage directory must be an absolute path.");
  }

  const protectedDataDir = opts.protectedDataDir;
  if (typeof protectedDataDir !== "string" || protectedDataDir.trim() === "") {
    return fail(
      "INVALID_OPTIONS",
      "The protected Centre data directory must be supplied explicitly."
    );
  }
  if (!path.isAbsolute(protectedDataDir)) {
    return fail(
      "INVALID_OPTIONS",
      "The protected Centre data directory must be an absolute path."
    );
  }

  const lexicalStorage = path.resolve(storageDir);
  if (hasCentreDataSegment(lexicalStorage)) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage must not use the Centre data directory."
    );
  }

  // Reject a final storage component that is itself a link or a non-directory.
  try {
    const stats = fs.lstatSync(lexicalStorage);
    if (stats.isSymbolicLink()) {
      return fail(
        "UNSAFE_LICENSE_STORAGE",
        "License storage directory must not be a symbolic link."
      );
    }
    if (!stats.isDirectory()) {
      return fail("UNSAFE_LICENSE_STORAGE", "License storage path is not a directory.");
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      return fail(
        "UNSAFE_LICENSE_STORAGE",
        "License storage directory could not be inspected."
      );
    }
  }

  let canonicalStorage;
  let canonicalProtected;
  try {
    canonicalStorage = canonicalizePath(lexicalStorage);
    canonicalProtected = canonicalizePath(protectedDataDir);
  } catch (error) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage path could not be resolved safely."
    );
  }

  if (hasCentreDataSegment(canonicalStorage)) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage resolves into the Centre data directory."
    );
  }

  const storageKey = comparisonKey(canonicalStorage);
  const dataKey = comparisonKey(canonicalProtected);

  if (
    isSameOrDescendant(storageKey, dataKey) ||
    isSameOrDescendant(dataKey, storageKey)
  ) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage must not overlap the Centre data directory."
    );
  }

  return {
    ok: true,
    data: {
      directory: canonicalStorage,
      file: path.join(canonicalStorage, LICENSE_FILE_NAME),
      protectedDataDir: canonicalProtected,
    },
  };
}

/**
 * Validate license-file shape and size. This does not verify the signature;
 * `loadActivatedLicense` performs full cryptographic and device verification.
 */
function validateLicenseEnvelope(input) {
  let envelope = input;

  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_LICENSE_BYTES) {
      return fail("LICENSE_TOO_LARGE", "License file is too large.");
    }
    try {
      envelope = JSON.parse(input);
    } catch (error) {
      return fail("LICENSE_INVALID", "License file is not valid JSON.");
    }
  }

  if (!isPlainObject(envelope)) {
    return fail("LICENSE_INVALID", "License file is not a valid license envelope.");
  }

  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (error) {
    return fail("LICENSE_INVALID", "License envelope could not be serialized.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_LICENSE_BYTES) {
    return fail("LICENSE_TOO_LARGE", "License file is too large.");
  }

  if (envelope.schema !== LICENSE_SCHEMA || envelope.alg !== LICENSE_ALGORITHM) {
    return fail("LICENSE_INVALID", "License envelope schema or algorithm is not supported.");
  }
  if (typeof envelope.keyId !== "string" || !KEY_ID_RE.test(envelope.keyId)) {
    return fail("LICENSE_INVALID", "License envelope key ID is invalid.");
  }
  if (typeof envelope.payload !== "string" || envelope.payload.length === 0) {
    return fail("LICENSE_INVALID", "License envelope payload is invalid.");
  }
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
    return fail("LICENSE_INVALID", "License envelope signature is invalid.");
  }

  return { ok: true, data: envelope };
}

async function inspectStorageDirectory(directory) {
  let stats;
  try {
    stats = await fs.promises.lstat(directory);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, exists: false };
    }
    return fail("UNSAFE_LICENSE_STORAGE", "License storage directory could not be inspected.");
  }

  if (stats.isSymbolicLink()) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage directory must not be a symbolic link."
    );
  }
  if (!stats.isDirectory()) {
    return fail("UNSAFE_LICENSE_STORAGE", "License storage path is not a directory.");
  }

  // The directory was canonicalized before this check. If it now resolves
  // somewhere else, a link or reparse point appeared after validation.
  try {
    const real = fs.realpathSync.native
      ? fs.realpathSync.native(directory)
      : fs.realpathSync(directory);
    if (comparisonKey(real) !== comparisonKey(directory)) {
      return fail(
        "UNSAFE_LICENSE_STORAGE",
        "License storage directory must not be a link or reparse point."
      );
    }
  } catch (error) {
    return fail("UNSAFE_LICENSE_STORAGE", "License storage directory could not be inspected.");
  }

  return { ok: true, exists: true };
}

/**
 * Read the raw license file text from a dedicated storage directory.
 * Returns `LICENSE_MISSING` when the directory or file does not exist.
 *
 * The file is opened once and inspected through the open handle, so a local
 * attacker cannot swap it for a symlink between the check and the read.
 */
async function readLicenseFile(storageDir, options) {
  const resolved = resolveLicenseStorage(storageDir, options);
  if (!resolved.ok) return resolved;

  const directory = await inspectStorageDirectory(resolved.data.directory);
  if (!directory.ok) return directory;
  if (!directory.exists) {
    return fail("LICENSE_MISSING", "No license file was found.");
  }

  let stats;
  try {
    stats = await fs.promises.lstat(resolved.data.file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fail("LICENSE_MISSING", "No license file was found.");
    }
    return fail("LICENSE_UNREADABLE", "License file could not be read.");
  }

  if (stats.isSymbolicLink()) {
    return fail("LICENSE_UNREADABLE", "License file must not be a symbolic link.");
  }
  if (!stats.isFile()) {
    return fail("LICENSE_UNREADABLE", "License path is not a regular file.");
  }
  if (stats.size > MAX_LICENSE_BYTES) {
    return fail("LICENSE_TOO_LARGE", "License file is too large.");
  }

  let handle = null;
  try {
    handle = await fs.promises.open(resolved.data.file, READ_ONLY_FLAGS);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      return fail("LICENSE_UNREADABLE", "License path is not a regular file.");
    }
    if (openedStats.size > MAX_LICENSE_BYTES) {
      return fail("LICENSE_TOO_LARGE", "License file is too large.");
    }

    const buffer = Buffer.alloc(openedStats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read || read.bytesRead === 0) break;
      offset += read.bytesRead;
    }

    let text = buffer.subarray(0, offset).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, data: text, path: resolved.data.file };
  } catch (error) {
    return fail("LICENSE_UNREADABLE", "License file could not be read.");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        // Ignore cleanup failure.
      }
    }
  }
}

/**
 * Replace the target through a single rename. Never remove the existing target
 * first. If the platform cannot replace it safely, the error is propagated so
 * the caller can fail closed with the old license still in place.
 *
 * `rename` is injectable for fault-injection tests; production callers use
 * `fs.promises.rename`.
 */
async function replaceFileAtomically(tempPath, targetPath, rename) {
  const renameFile = typeof rename === "function" ? rename : fs.promises.rename;
  await renameFile(tempPath, targetPath);
}

/**
 * Validate, cryptographically verify, device-match, and write a signed license
 * envelope to `<storageDir>/license.json`.
 *
 * Replacement is fail-closed: the new envelope must be signed by a trusted
 * key AND bound to the supplied current device identifiers before any file is
 * created or replaced. An invalid, untrusted, or mismatched license therefore
 * never replaces an existing valid license. `registry` and
 * `deviceIdentifiers` are required options.
 *
 * The write is performed through a temporary file in the same directory. A
 * failed replacement removes only that temporary file and leaves any existing
 * license untouched. It never writes outside the supplied license directory.
 */
async function writeLicenseFile(storageDir, envelopeInput, options) {
  const opts = options && typeof options === "object" ? options : {};

  const resolved = resolveLicenseStorage(storageDir, opts);
  if (!resolved.ok) return resolved;

  const validated = validateLicenseEnvelope(envelopeInput);
  if (!validated.ok) return validated;

  // Verify the new license before touching the storage directory. The
  // signature and signed device binding are checked first, then the binding is
  // matched against the current device. Nothing is written on failure.
  const verified = verifyActivatedLicense(validated.data, {
    registry: opts.registry,
    now: opts.now,
    deviceIdentifiers: opts.deviceIdentifiers,
  });
  if (!verified.ok) return verified;

  const directory = await inspectStorageDirectory(resolved.data.directory);
  if (!directory.ok) return directory;
  if (!directory.exists) {
    try {
      await fs.promises.mkdir(resolved.data.directory, {
        recursive: true,
        mode: 0o700,
      });
    } catch (error) {
      return fail("LICENSE_WRITE_FAILED", "License storage directory could not be created.");
    }
  }

  // Re-check after directory creation: the canonical path must still be the
  // same and must still not overlap the protected data directory.
  const rechecked = resolveLicenseStorage(storageDir, opts);
  if (!rechecked.ok) return rechecked;
  if (comparisonKey(rechecked.data.directory) !== comparisonKey(resolved.data.directory)) {
    return fail(
      "UNSAFE_LICENSE_STORAGE",
      "License storage path changed while it was being created."
    );
  }

  const readyDirectory = await inspectStorageDirectory(rechecked.data.directory);
  if (!readyDirectory.ok) return readyDirectory;
  if (!readyDirectory.exists) {
    return fail("LICENSE_WRITE_FAILED", "License storage directory is not available.");
  }

  const serialized = JSON.stringify(validated.data, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_LICENSE_BYTES) {
    return fail("LICENSE_TOO_LARGE", "License file is too large.");
  }

  const tempPath = path.join(
    rechecked.data.directory,
    "." + LICENSE_FILE_NAME + "." + process.pid + "." +
      crypto.randomBytes(6).toString("hex") + ".tmp"
  );

  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await replaceFileAtomically(tempPath, rechecked.data.file, opts.rename);

    // Best-effort durability for the directory entry. Failures here do not
    // invalidate the successfully replaced license.
    try {
      const directoryHandle = await fs.promises.open(
        rechecked.data.directory,
        fs.constants.O_RDONLY
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (syncError) {
      // Directory fsync is not supported on every platform.
    }

    return { ok: true, data: { path: rechecked.data.file } };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        // Ignore cleanup failure.
      }
    }
    try {
      await fs.promises.rm(tempPath, { force: true });
    } catch (cleanupError) {
      // Ignore cleanup failure; only our temporary file is targeted.
    }
    return fail("LICENSE_WRITE_FAILED", "License file could not be written.");
  }
}

/**
 * Map a low-level verification failure onto the stable storage-facing result
 * shape. Device and option errors are returned unchanged; every other
 * verification failure is reported as `LICENSE_INVALID` with a `cause` code.
 */
function toLoadFailure(verified) {
  if (verified.code === "INVALID_OPTIONS" || DEVICE_CODES.has(verified.code)) {
    return verified;
  }
  return {
    ok: false,
    code: "LICENSE_INVALID",
    error: "License file is invalid or not authentic.",
    cause: verified.code,
  };
}

/**
 * Read, cryptographically verify, and device-match the stored license.
 *
 * Two modes are supported:
 * - `deviceIdentifiers`: identifiers were already collected by the caller.
 * - `collectIdentifiers(options)`: the stored envelope is read and its
 *   signature verified first; the identifier names are then taken from the
 *   verified signed binding and only those identifiers are collected. This
 *   avoids collecting identifiers that the binding does not require and keeps
 *   an unsigned/tampered binding from influencing collection.
 *
 * Successful result: `{ ok: true, data: payload }`.
 * Missing file: `LICENSE_MISSING`.
 * Invalid or unauthentic envelope: `LICENSE_INVALID` with a `cause` code.
 * Device problems: `DEVICE_REQUIRED`, `DEVICE_MISMATCH`,
 * `IDENTIFIER_UNAVAILABLE`, or `MALFORMED_DEVICE_BINDING`.
 */
async function loadActivatedLicense(options) {
  const opts = options && typeof options === "object" ? options : {};
  const hasIdentifiers = isPlainObject(opts.deviceIdentifiers);
  const hasCollector = typeof opts.collectIdentifiers === "function";

  if (!hasIdentifiers && !hasCollector) {
    return fail(
      "INVALID_OPTIONS",
      "Current device identifiers or a device identifier collector must be provided."
    );
  }

  const read = await readLicenseFile(opts.storageDir, {
    protectedDataDir: opts.protectedDataDir,
  });
  if (!read.ok) return read;

  if (hasIdentifiers) {
    const verified = verifyActivatedLicense(read.data, {
      registry: opts.registry,
      now: opts.now,
      deviceIdentifiers: opts.deviceIdentifiers,
    });

    if (verified.ok) {
      return { ok: true, data: verified.data, path: read.path };
    }
    return toLoadFailure(verified);
  }

  // Verify the signature and signed binding before trusting identifier names
  // or invoking the collector.
  const verified = verifyActivatedLicenseSignature(read.data, {
    registry: opts.registry,
    now: opts.now,
  });
  if (!verified.ok) return toLoadFailure(verified);

  let collected;
  try {
    collected = await opts.collectIdentifiers({
      identifiers: verified.identifiers.slice(),
      platform: opts.platform,
    });
  } catch (error) {
    return fail(
      "IDENTIFIER_UNAVAILABLE",
      "The current device identifiers could not be collected."
    );
  }

  if (!collected || collected.ok !== true || !isPlainObject(collected.data)) {
    const result = fail(
      collected && typeof collected.code === "string"
        ? collected.code
        : "IDENTIFIER_UNAVAILABLE",
      "The current device identifiers are unavailable.",
      collected && collected.identifier
    );
    if (collected && Array.isArray(collected.unavailable)) {
      result.unavailable = collected.unavailable.slice();
    }
    return result;
  }

  const matched = matchDeviceBinding(verified.data.device, collected.data);
  if (!matched.ok) return matched;

  return { ok: true, data: verified.data, path: read.path };
}

module.exports = {
  LICENSE_FILE_NAME: LICENSE_FILE_NAME,
  resolveLicenseStorage: resolveLicenseStorage,
  validateLicenseEnvelope: validateLicenseEnvelope,
  readLicenseFile: readLicenseFile,
  writeLicenseFile: writeLicenseFile,
  loadActivatedLicense: loadActivatedLicense,
};
