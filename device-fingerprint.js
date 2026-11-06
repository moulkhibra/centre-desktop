"use strict";

/**
 * Centre Windows device fingerprinting (Phase 2).
 *
 * This module is intentionally independent of Electron, application startup,
 * user data, license storage, and activation UI. It performs no logging and
 * never writes identifiers to disk.
 *
 * Design:
 * - Pure normalization, hashing, binding, and matching functions.
 * - Windows command collection is isolated behind an injectable `runCommand`.
 * - Raw identifiers are hashed before they can be placed in a license payload.
 * - Errors contain identifier names only, never raw values or command output.
 *
 * Required production identifiers:
 * - `machineGuid`   (HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid)
 * - `smbiosUuid`    (Win32_ComputerSystemProduct.UUID)
 *
 * Optional identifier:
 * - `systemVolumeSerial` (Win32_LogicalDisk.VolumeSerialNumber for the boot
 *   drive). It is supported only in addition to both required identifiers.
 *   It changes when the system volume is formatted or replaced, is sometimes
 *   unavailable/zeroed, and adds reissue risk without materially improving
 *   casual-copy resistance beyond MachineGuid + SMBIOS UUID. Owners can
 *   explicitly select it for a stricter binding.
 *
 * Binding format stored in the signed license payload:
 * {
 *   "scheme": "centre-device/1",
 *   "match": "all",
 *   "identifiers": {
 *     "machineGuid": "sha256:<64 lowercase hex>",
 *     "smbiosUuid": "sha256:<64 lowercase hex>"
 *   }
 * }
 *
 * Matching is strict: every identifier present in the binding must be
 * available on the current PC and its hash must match. Missing or unavailable
 * selected identifiers fail closed. Extra current identifiers are ignored.
 * A standard production binding must contain both `machineGuid` and
 * `smbiosUuid`; the optional volume serial may only be added to that pair.
 *
 * Known placeholder SMBIOS UUIDs are rejected both as raw values and as
 * pre-hashed binding entries. Such UUIDs are shared by many OEM/VMs and would
 * weaken per-machine binding.
 *
 * Limitations:
 * - Windows reinstall/sysprep can change MachineGuid and require reissue.
 * - Motherboard replacement can change SMBIOS UUID and require reissue.
 * - System-volume replacement/format can change the optional volume serial.
 * - Hardware identifiers can be spoofed, and cloned VM images may share them.
 * - Device binding is a deterrent, not an impossible-to-bypass protection.
 */

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const DEVICE_SCHEME = "centre-device/1";
const HASH_PREFIX = "sha256:";
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GUID_RE = /^[0-9a-f]{32}$/;
const VOLUME_SERIAL_RE = /^[0-9a-f]{8}$/;

const REQUIRED_IDENTIFIERS = Object.freeze(["machineGuid", "smbiosUuid"]);
const DEFAULT_IDENTIFIERS = REQUIRED_IDENTIFIERS;
const SUPPORTED_IDENTIFIERS = Object.freeze(["machineGuid", "smbiosUuid", "systemVolumeSerial"]);
const SUPPORTED_SET = new Set(SUPPORTED_IDENTIFIERS);
const REQUIRED_SET = new Set(REQUIRED_IDENTIFIERS);

// Compact, normalized placeholder UUIDs that OEMs and virtual machines reuse.
// These are not unique to a PC and must never be accepted as a binding.
const PLACEHOLDER_SMBIOS_UUIDS = Object.freeze([
  "03000200040005000006000700080009",
  "00020003000400050006000700080009",
  "12345678123456781234567812345678",
]);
const PLACEHOLDER_SMBIOS_SET = new Set(PLACEHOLDER_SMBIOS_UUIDS);

const MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
const SMBIOS_COMMAND =
  "(Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID";
const VOLUME_COMMAND =
  "$d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop | " +
  "Where-Object { $_.DeviceID -eq $env:SystemDrive }; $d.VolumeSerialNumber";

const COMMAND_OPTIONS = Object.freeze({
  windowsHide: true,
  timeout: 5000,
  maxBuffer: 64 * 1024,
  encoding: "utf8",
});

const execFileAsync = promisify(execFile);

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeGuid(value) {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[{}\s-]/g, "").toLowerCase();
  if (!GUID_RE.test(compact)) return null;
  if (/^0{32}$/.test(compact) || /^f{32}$/.test(compact)) return null;
  return compact;
}

function normalizeVolumeSerial(value) {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\s-]/g, "").toLowerCase();
  if (!VOLUME_SERIAL_RE.test(compact)) return null;
  if (compact === "00000000" || compact === "ffffffff") return null;
  return compact;
}

/**
 * Normalize one identifier to a canonical, case-insensitive form.
 * Returns null for unknown identifiers, malformed values, or sentinel
 * all-zero/all-F values that should be treated as unavailable.
 */
function normalizeIdentifier(identifier, value) {
  if (identifier === "smbiosUuid") {
    const normalized = normalizeGuid(value);
    if (normalized === null || PLACEHOLDER_SMBIOS_SET.has(normalized)) return null;
    return normalized;
  }
  if (identifier === "machineGuid") {
    return normalizeGuid(value);
  }
  if (identifier === "systemVolumeSerial") {
    return normalizeVolumeSerial(value);
  }
  return null;
}

function hashNormalized(identifier, normalized) {
  const digest = crypto
    .createHash("sha256")
    .update(DEVICE_SCHEME + "|" + identifier + "|" + normalized, "utf8")
    .digest("hex");
  return HASH_PREFIX + digest;
}

/**
 * Hashes of known placeholder SMBIOS UUIDs. Issuance and activation reject
 * these hashes so a manually supplied placeholder binding cannot slip through
 * the raw-value normalizer.
 */
const PLACEHOLDER_SMBIOS_HASHES = Object.freeze(
  PLACEHOLDER_SMBIOS_UUIDS.map(function (uuid) {
    return hashNormalized("smbiosUuid", uuid);
  })
);
const PLACEHOLDER_SMBIOS_HASH_SET = new Set(PLACEHOLDER_SMBIOS_HASHES);

function isPlaceholderSmbiosHash(value) {
  return typeof value === "string" && PLACEHOLDER_SMBIOS_HASH_SET.has(value);
}

/**
 * Hash a normalized identifier for storage in a signed license payload.
 * The identifier kind is part of the domain separator so hashes cannot be
 * swapped between fields.
 */
function hashIdentifier(identifier, value) {
  const normalized = normalizeIdentifier(identifier, value);
  if (normalized === null) return null;
  return hashNormalized(identifier, normalized);
}

function validateIdentifiers(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("INVALID_IDENTIFIERS", "At least one device identifier must be selected.");
  }
  const seen = new Set();
  for (const identifier of value) {
    if (typeof identifier !== "string" || !SUPPORTED_SET.has(identifier)) {
      return fail("INVALID_IDENTIFIERS", "Selected device identifier is not supported.");
    }
    if (seen.has(identifier)) {
      return fail("INVALID_IDENTIFIERS", "Selected device identifiers must not contain duplicates.");
    }
    seen.add(identifier);
  }
  for (const identifier of REQUIRED_IDENTIFIERS) {
    if (!seen.has(identifier)) {
      return fail(
        "INVALID_IDENTIFIERS",
        "A standard device binding must include machineGuid and smbiosUuid.",
        identifier
      );
    }
  }
  return { ok: true, data: value.slice() };
}

/**
 * Create a signable device binding from collected raw values.
 * All selected identifiers must be available; nothing is silently dropped.
 */
function createDeviceBinding(values, options) {
  const opts = options && typeof options === "object" ? options : {};
  const selection = validateIdentifiers(
    opts.identifiers === undefined ? DEFAULT_IDENTIFIERS : opts.identifiers
  );
  if (!selection.ok) return selection;
  if (!isPlainObject(values)) {
    return fail("MALFORMED_IDENTIFIERS", "Collected device identifiers must be an object.");
  }

  const identifiers = {};
  for (const identifier of selection.data) {
    if (!hasOwn(values, identifier)) {
      return fail(
        "IDENTIFIER_UNAVAILABLE",
        "A required device identifier is unavailable.",
        identifier
      );
    }
    const hash = hashIdentifier(identifier, values[identifier]);
    if (hash === null) {
      return fail(
        "IDENTIFIER_UNAVAILABLE",
        "A required device identifier is unavailable.",
        identifier
      );
    }
    identifiers[identifier] = hash;
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

function validateDeviceBinding(binding) {
  if (!isPlainObject(binding)) {
    return fail("MALFORMED_DEVICE_BINDING", "Device binding must be an object.");
  }
  if (binding.scheme !== DEVICE_SCHEME) {
    return fail("MALFORMED_DEVICE_BINDING", "Device binding scheme is not supported.");
  }
  if (binding.match !== "all") {
    return fail("MALFORMED_DEVICE_BINDING", "Device binding must require all identifiers.");
  }
  if (!isPlainObject(binding.identifiers)) {
    return fail("MALFORMED_DEVICE_BINDING", "Device binding identifiers must be an object.");
  }

  const names = Object.keys(binding.identifiers);
  if (names.length === 0) {
    return fail("MALFORMED_DEVICE_BINDING", "Device binding must select at least one identifier.");
  }
  for (const name of names) {
    if (!SUPPORTED_SET.has(name)) {
      return fail("MALFORMED_DEVICE_BINDING", "Device binding contains an unsupported identifier.");
    }
    if (typeof binding.identifiers[name] !== "string" || !HASH_RE.test(binding.identifiers[name])) {
      return fail("MALFORMED_DEVICE_BINDING", "Device binding contains an invalid identifier hash.");
    }
  }
  for (const identifier of REQUIRED_IDENTIFIERS) {
    if (!hasOwn(binding.identifiers, identifier)) {
      return fail(
        "MALFORMED_DEVICE_BINDING",
        "A standard device binding must include machineGuid and smbiosUuid.",
        identifier
      );
    }
  }
  if (isPlaceholderSmbiosHash(binding.identifiers.smbiosUuid)) {
    return fail(
      "MALFORMED_DEVICE_BINDING",
      "Device binding uses a placeholder SMBIOS UUID.",
      "smbiosUuid"
    );
  }

  return { ok: true, data: binding };
}

/**
 * Strictly match a signed device binding against current raw values.
 * Every selected identifier must be present and hash-identical.
 */
function matchDeviceBinding(binding, values) {
  const validated = validateDeviceBinding(binding);
  if (!validated.ok) return validated;
  if (!isPlainObject(values)) {
    return fail("MALFORMED_IDENTIFIERS", "Collected device identifiers must be an object.");
  }

  const names = Object.keys(validated.data.identifiers);
  for (const identifier of names) {
    if (!hasOwn(values, identifier)) {
      return fail(
        "IDENTIFIER_UNAVAILABLE",
        "A required device identifier is unavailable.",
        identifier
      );
    }
    const actual = hashIdentifier(identifier, values[identifier]);
    if (actual === null) {
      return fail(
        "IDENTIFIER_UNAVAILABLE",
        "A required device identifier is unavailable.",
        identifier
      );
    }
    if (actual !== validated.data.identifiers[identifier]) {
      return fail(
        "DEVICE_MISMATCH",
        "A device identifier does not match the license binding.",
        identifier
      );
    }
  }

  return { ok: true, data: { identifiers: names } };
}

function parseMachineGuid(output) {
  const text = typeof output === "string" ? output : "";
  const match = /MachineGuid\s+REG_SZ\s+([^\s]+)/i.exec(text);
  return match ? normalizeGuid(match[1]) : null;
}

function parseSmbiosUuid(output) {
  const text = typeof output === "string" ? output : "";
  const match =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i.exec(text);
  return match ? normalizeGuid(match[0]) : null;
}

function parseVolumeSerial(output) {
  const text = typeof output === "string" ? output : "";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*([0-9a-f]{8})\s*$/i.exec(line);
    if (match) return normalizeVolumeSerial(match[1]);
  }
  return null;
}

function defaultRunCommand(file, args) {
  return execFileAsync(file, args, COMMAND_OPTIONS);
}

async function readMachineGuid(runCommand) {
  const baseArgs = ["query", MACHINE_GUID_KEY, "/v", "MachineGuid"];
  try {
    const result = await runCommand("reg.exe", baseArgs.concat("/reg:64"), COMMAND_OPTIONS);
    const parsed = parseMachineGuid(result && result.stdout);
    if (parsed !== null) return parsed;
  } catch (error) {
    // Fall through to the default registry view.
  }
  const result = await runCommand("reg.exe", baseArgs, COMMAND_OPTIONS);
  return parseMachineGuid(result && result.stdout);
}

async function readSmbiosUuid(runCommand) {
  try {
    const result = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SMBIOS_COMMAND],
      COMMAND_OPTIONS
    );
    const parsed = parseSmbiosUuid(result && result.stdout);
    if (parsed !== null) return parsed;
  } catch (error) {
    // Fall through to the legacy WMIC command.
  }

  const result = await runCommand(
    "wmic.exe",
    ["csproduct", "get", "uuid", "/value"],
    COMMAND_OPTIONS
  );
  return parseSmbiosUuid(result && result.stdout);
}

async function readVolumeSerial(runCommand) {
  const result = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", VOLUME_COMMAND],
    COMMAND_OPTIONS
  );
  return parseVolumeSerial(result && result.stdout);
}

async function collectOne(identifier, runCommand) {
  if (identifier === "machineGuid") return readMachineGuid(runCommand);
  if (identifier === "smbiosUuid") return readSmbiosUuid(runCommand);
  if (identifier === "systemVolumeSerial") return readVolumeSerial(runCommand);
  return null;
}

/**
 * Collect selected Windows identifiers. This is the only platform-specific
 * part of the module. Commands and arguments are fixed; no caller-controlled
 * input is passed to the shell, and `shell: false` is the execFile default.
 *
 * `options.runCommand` is an injection point for tests and future adapters.
 * It must resolve to `{ stdout, stderr }`.
 *
 * Returns `{ ok: true, data, unavailable: [] }` only when every selected
 * identifier was collected. If any identifier is unavailable, it returns
 * `IDENTIFIER_UNAVAILABLE` with the full `unavailable` list and no `data`, so
 * a caller cannot mistake a partial fingerprint for a complete one.
 * It never includes raw command output in errors.
 */
async function collectWindowsIdentifiers(options) {
  const opts = options && typeof options === "object" ? options : {};
  const platform = opts.platform === undefined ? process.platform : opts.platform;
  if (platform !== "win32") {
    return fail("UNSUPPORTED_PLATFORM", "Windows device identifiers are only available on Windows.");
  }

  const selection = validateIdentifiers(
    opts.identifiers === undefined ? DEFAULT_IDENTIFIERS : opts.identifiers
  );
  if (!selection.ok) return selection;

  const runCommand = typeof opts.runCommand === "function" ? opts.runCommand : defaultRunCommand;
  const values = Object.create(null);
  const unavailable = [];

  for (const identifier of selection.data) {
    let value = null;
    try {
      value = await collectOne(identifier, runCommand);
    } catch (error) {
      value = null;
    }
    const normalized = normalizeIdentifier(identifier, value);
    values[identifier] = normalized;
    if (normalized === null) unavailable.push(identifier);
  }

  if (unavailable.length > 0) {
    const result = fail(
      "IDENTIFIER_UNAVAILABLE",
      "One or more required device identifiers could not be collected.",
      unavailable[0]
    );
    result.unavailable = unavailable.slice();
    return result;
  }

  return { ok: true, data: values, unavailable: [] };
}

/**
 * Collect and immediately produce a signable device binding.
 */
async function createWindowsDeviceBinding(options) {
  const opts = options && typeof options === "object" ? options : {};
  const collected = await collectWindowsIdentifiers(opts);
  if (!collected.ok) return collected;
  return createDeviceBinding(collected.data, opts);
}

/**
 * Collect only the identifiers selected by a binding, then match strictly.
 */
async function matchWindowsDeviceBinding(binding, options) {
  const validated = validateDeviceBinding(binding);
  if (!validated.ok) return validated;

  const opts = options && typeof options === "object" ? options : {};
  const collected = await collectWindowsIdentifiers(
    Object.assign({}, opts, { identifiers: Object.keys(validated.data.identifiers) })
  );
  if (!collected.ok) return collected;
  return matchDeviceBinding(validated.data, collected.data);
}

module.exports = {
  DEVICE_SCHEME: DEVICE_SCHEME,
  REQUIRED_IDENTIFIERS: REQUIRED_IDENTIFIERS,
  DEFAULT_IDENTIFIERS: DEFAULT_IDENTIFIERS,
  SUPPORTED_IDENTIFIERS: SUPPORTED_IDENTIFIERS,
  PLACEHOLDER_SMBIOS_UUIDS: PLACEHOLDER_SMBIOS_UUIDS,
  PLACEHOLDER_SMBIOS_HASHES: PLACEHOLDER_SMBIOS_HASHES,
  isPlaceholderSmbiosHash: isPlaceholderSmbiosHash,
  normalizeIdentifier: normalizeIdentifier,
  hashIdentifier: hashIdentifier,
  createDeviceBinding: createDeviceBinding,
  validateDeviceBinding: validateDeviceBinding,
  matchDeviceBinding: matchDeviceBinding,
  collectWindowsIdentifiers: collectWindowsIdentifiers,
  createWindowsDeviceBinding: createWindowsDeviceBinding,
  matchWindowsDeviceBinding: matchWindowsDeviceBinding,
};
