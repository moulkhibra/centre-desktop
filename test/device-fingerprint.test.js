"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEVICE_SCHEME,
  REQUIRED_IDENTIFIERS,
  DEFAULT_IDENTIFIERS,
  SUPPORTED_IDENTIFIERS,
  PLACEHOLDER_SMBIOS_UUIDS,
  PLACEHOLDER_SMBIOS_HASHES,
  isPlaceholderSmbiosHash,
  normalizeIdentifier,
  hashIdentifier,
  createDeviceBinding,
  matchDeviceBinding,
  collectWindowsIdentifiers,
  createWindowsDeviceBinding,
  matchWindowsDeviceBinding,
} = require("../device-fingerprint");

const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const VOLUME_SERIAL = "1A2B3C4D";

function makeValues(overrides) {
  return Object.assign({
    machineGuid: MACHINE_GUID,
    smbiosUuid: SMBIOS_UUID,
    systemVolumeSerial: VOLUME_SERIAL,
  }, overrides || {});
}

function canonicalGuid(value) {
  return value.replace(/[{}\s-]/g, "").toLowerCase();
}

function assertNoRawIdentifiers(value, raws) {
  const serialized = JSON.stringify(value);
  for (const raw of raws) {
    assert.equal(serialized.includes(raw), false, "raw identifier leaked: " + raw);
    assert.equal(serialized.includes(raw.toLowerCase()), false, "raw identifier leaked: " + raw);
  }
}

function fakeRunner(outputs) {
  const source = outputs || {};
  const calls = [];

  async function runCommand(file, args, options) {
    calls.push({ file: file, args: args.slice(), options: options });

    if (file === "reg.exe") {
      if (args.includes("/reg:64")) {
        if (source.reg64Error) throw new Error(source.reg64Error);
        return { stdout: source.reg64 || "", stderr: "" };
      }
      if (source.regError) throw new Error(source.regError);
      return { stdout: source.reg || "", stderr: "" };
    }

    if (file === "powershell.exe") {
      if (args.some((arg) => arg.includes("Win32_ComputerSystemProduct"))) {
        if (source.smbiosError) throw new Error(source.smbiosError);
        return { stdout: source.smbios || "", stderr: "" };
      }
      if (args.some((arg) => arg.includes("Win32_LogicalDisk"))) {
        if (source.volumeError) throw new Error(source.volumeError);
        return { stdout: source.volume || "", stderr: "" };
      }
    }

    if (file === "wmic.exe") {
      if (source.wmicError) throw new Error(source.wmicError);
      return { stdout: source.wmic || "", stderr: "" };
    }

    throw new Error("unexpected command");
  }

  return { runCommand: runCommand, calls: calls };
}

const GOOD_OUTPUTS = {
  reg64:
    "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n" +
    "    MachineGuid    REG_SZ    " + MACHINE_GUID + "\r\n\r\n",
  smbios: "\r\n" + SMBIOS_UUID + "\r\n",
  volume: "\r\n" + VOLUME_SERIAL + "\r\n",
};

test("normalizes GUID identifiers to canonical lowercase 32-hex values", () => {
  const expectedMachine = canonicalGuid(MACHINE_GUID);
  const expectedSmbios = canonicalGuid(SMBIOS_UUID);

  assert.equal(normalizeIdentifier("machineGuid", MACHINE_GUID), expectedMachine);
  assert.equal(normalizeIdentifier("machineGuid", "{" + MACHINE_GUID + "}"), expectedMachine);
  assert.equal(normalizeIdentifier("machineGuid", "  " + MACHINE_GUID + "  "), expectedMachine);
  assert.equal(normalizeIdentifier("machineGuid", expectedMachine), expectedMachine);
  assert.equal(normalizeIdentifier("smbiosUuid", SMBIOS_UUID.toLowerCase()), expectedSmbios);

  assert.equal(normalizeIdentifier("machineGuid", ""), null);
  assert.equal(normalizeIdentifier("machineGuid", "not-a-guid"), null);
  assert.equal(normalizeIdentifier("machineGuid", "00000000-0000-0000-0000-000000000000"), null);
  assert.equal(normalizeIdentifier("smbiosUuid", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), null);
  assert.equal(normalizeIdentifier("machineGuid", 12345), null);
  assert.equal(normalizeIdentifier("unknown", MACHINE_GUID), null);
});

test("normalizes the optional system-volume serial", () => {
  assert.equal(normalizeIdentifier("systemVolumeSerial", VOLUME_SERIAL), "1a2b3c4d");
  assert.equal(normalizeIdentifier("systemVolumeSerial", " 1a2b 3c4d "), "1a2b3c4d");
  assert.equal(normalizeIdentifier("systemVolumeSerial", "1A2B-3C4D"), "1a2b3c4d");
  assert.equal(normalizeIdentifier("systemVolumeSerial", "00000000"), null);
  assert.equal(normalizeIdentifier("systemVolumeSerial", "FFFFFFFF"), null);
  assert.equal(normalizeIdentifier("systemVolumeSerial", "1234"), null);
  assert.equal(normalizeIdentifier("systemVolumeSerial", 12345678), null);
});

test("hashes identifiers deterministically with domain separation", () => {
  const machineHash = hashIdentifier("machineGuid", MACHINE_GUID);
  const smbiosHash = hashIdentifier("smbiosUuid", SMBIOS_UUID);

  assert.match(machineHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(smbiosHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashIdentifier("machineGuid", "{" + MACHINE_GUID + "}"), machineHash);
  assert.equal(hashIdentifier("machineGuid", MACHINE_GUID.toLowerCase()), machineHash);

  assert.notEqual(hashIdentifier("machineGuid", MACHINE_GUID), hashIdentifier("machineGuid", SMBIOS_UUID));
  assert.notEqual(hashIdentifier("machineGuid", MACHINE_GUID), hashIdentifier("smbiosUuid", MACHINE_GUID));
  assert.equal(hashIdentifier("machineGuid", ""), null);
  assert.equal(hashIdentifier("unknown", MACHINE_GUID), null);

  assert.equal(machineHash.includes(MACHINE_GUID), false);
  assert.equal(machineHash.includes(canonicalGuid(MACHINE_GUID)), false);
});

test("creates a strict binding using MachineGuid and SMBIOS UUID by default", () => {
  const result = createDeviceBinding(makeValues());

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.scheme, DEVICE_SCHEME);
  assert.equal(result.data.match, "all");
  assert.deepEqual(Object.keys(result.data.identifiers), Array.from(DEFAULT_IDENTIFIERS));
  assert.deepEqual(Object.keys(result.data.identifiers), ["machineGuid", "smbiosUuid"]);
  assert.match(result.data.identifiers.machineGuid, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.data.identifiers.smbiosUuid, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result.data.identifiers, "systemVolumeSerial"), false);
  assertNoRawIdentifiers(result, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
});

test("supports the optional system-volume serial when explicitly selected", () => {
  const result = createDeviceBinding(makeValues(), {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.keys(result.data.identifiers), [
    "machineGuid",
    "smbiosUuid",
    "systemVolumeSerial",
  ]);
  assert.match(result.data.identifiers.systemVolumeSerial, /^sha256:[0-9a-f]{64}$/);
  assertNoRawIdentifiers(result, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
});

test("fails closed when any selected identifier is missing or unavailable", () => {
  for (const identifier of DEFAULT_IDENTIFIERS) {
    const values = makeValues();
    values[identifier] = null;
    const result = createDeviceBinding(values);

    assert.equal(result.ok, false, identifier);
    assert.equal(result.code, "IDENTIFIER_UNAVAILABLE", identifier);
    assert.equal(result.identifier, identifier);
    assertNoRawIdentifiers(result, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
  }

  const missingObject = createDeviceBinding(null);
  assert.equal(missingObject.code, "MALFORMED_IDENTIFIERS");

  const arrayValues = createDeviceBinding([]);
  assert.equal(arrayValues.code, "MALFORMED_IDENTIFIERS");

  const binding = createDeviceBinding(makeValues()).data;
  assert.equal(matchDeviceBinding(binding, null).code, "MALFORMED_IDENTIFIERS");
  assert.equal(matchDeviceBinding(binding, []).code, "MALFORMED_IDENTIFIERS");
});

test("validates the selected identifier list", () => {
  const cases = [
    [],
    ["unknown"],
    ["machineGuid", "machineGuid"],
    ["machineGuid", 42],
    "machineGuid",
    ["machineGuid"],
    ["smbiosUuid"],
    ["systemVolumeSerial"],
    ["machineGuid", "systemVolumeSerial"],
    ["smbiosUuid", "systemVolumeSerial"],
  ];

  for (const identifiers of cases) {
    const result = createDeviceBinding(makeValues(), { identifiers: identifiers });
    assert.equal(result.ok, false, String(identifiers));
    assert.equal(result.code, "INVALID_IDENTIFIERS", String(identifiers));
  }

  assert.deepEqual(Array.from(REQUIRED_IDENTIFIERS), ["machineGuid", "smbiosUuid"]);
  assert.deepEqual(Array.from(SUPPORTED_IDENTIFIERS), [
    "machineGuid",
    "smbiosUuid",
    "systemVolumeSerial",
  ]);
});

test("matches a binding only when every selected identifier matches", () => {
  const binding = createDeviceBinding(makeValues()).data;
  const exact = matchDeviceBinding(binding, makeValues());

  assert.equal(exact.ok, true, exact.error);
  assert.deepEqual(exact.data.identifiers, ["machineGuid", "smbiosUuid"]);

  const changedMachine = matchDeviceBinding(
    binding,
    makeValues({ machineGuid: "87654321-4321-4321-4321-BA0987654321" })
  );
  assert.equal(changedMachine.ok, false);
  assert.equal(changedMachine.code, "DEVICE_MISMATCH");
  assert.equal(changedMachine.identifier, "machineGuid");
  assertNoRawIdentifiers(changedMachine, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);

  const changedSmbios = matchDeviceBinding(
    binding,
    makeValues({ smbiosUuid: "11111111-2222-3333-4444-555555555555" })
  );
  assert.equal(changedSmbios.ok, false);
  assert.equal(changedSmbios.code, "DEVICE_MISMATCH");
  assert.equal(changedSmbios.identifier, "smbiosUuid");
});

test("fails closed when a required identifier is unavailable during matching", () => {
  const binding = createDeviceBinding(makeValues()).data;
  const values = makeValues();
  delete values.smbiosUuid;

  const result = matchDeviceBinding(binding, values);
  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(result.identifier, "smbiosUuid");
  assertNoRawIdentifiers(result, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
});

test("ignores current identifiers that are not selected by the binding", () => {
  const binding = createDeviceBinding(makeValues()).data;
  const result = matchDeviceBinding(
    binding,
    makeValues({
      systemVolumeSerial: "DEADBEEF",
      futureIdentifier: "ignored",
    })
  );

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.data.identifiers, ["machineGuid", "smbiosUuid"]);

  const volumeBinding = createDeviceBinding(makeValues(), {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  }).data;
  const changedVolume = matchDeviceBinding(
    volumeBinding,
    makeValues({ systemVolumeSerial: "DEADBEEF" })
  );
  assert.equal(changedVolume.ok, false);
  assert.equal(changedVolume.code, "DEVICE_MISMATCH");
  assert.equal(changedVolume.identifier, "systemVolumeSerial");
});

test("rejects incomplete production bindings", () => {
  const valid = createDeviceBinding(makeValues()).data;
  const validMachine = valid.identifiers.machineGuid;
  const validSmbios = valid.identifiers.smbiosUuid;
  const validVolume = hashIdentifier("systemVolumeSerial", VOLUME_SERIAL);

  const cases = [
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { machineGuid: validMachine } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { smbiosUuid: validSmbios } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { systemVolumeSerial: validVolume } },
    {
      scheme: DEVICE_SCHEME,
      match: "all",
      identifiers: { machineGuid: validMachine, systemVolumeSerial: validVolume },
    },
  ];

  for (const binding of cases) {
    const result = matchDeviceBinding(binding, makeValues());
    assert.equal(result.ok, false, JSON.stringify(binding));
    assert.equal(result.code, "MALFORMED_DEVICE_BINDING", JSON.stringify(binding));
  }
});

test("rejects malformed device bindings", () => {
  const validHash = hashIdentifier("machineGuid", MACHINE_GUID);
  const validSmbiosHash = hashIdentifier("smbiosUuid", SMBIOS_UUID);
  const cases = [
    null,
    [],
    {},
    { scheme: "other", match: "all", identifiers: { machineGuid: validHash } },
    { scheme: DEVICE_SCHEME, match: "any", identifiers: { machineGuid: validHash } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: null },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: [] },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: {} },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { unknown: validHash } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { machineGuid: "sha256:xyz" } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { machineGuid: validHash.toUpperCase() } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { machineGuid: 123 } },
    { scheme: DEVICE_SCHEME, match: "all", identifiers: { machineGuid: validHash } },
    {
      scheme: DEVICE_SCHEME,
      match: "all",
      identifiers: { machineGuid: validHash, smbiosUuid: validSmbiosHash.toUpperCase() },
    },
  ];

  for (const binding of cases) {
    const result = matchDeviceBinding(binding, makeValues());
    assert.equal(result.ok, false, JSON.stringify(binding));
    assert.equal(result.code, "MALFORMED_DEVICE_BINDING", JSON.stringify(binding));
  }
});

test("rejects known placeholder SMBIOS UUIDs and hashes", () => {
  assert.equal(PLACEHOLDER_SMBIOS_UUIDS.length > 0, true);
  assert.equal(PLACEHOLDER_SMBIOS_HASHES.length, PLACEHOLDER_SMBIOS_UUIDS.length);

  for (const uuid of PLACEHOLDER_SMBIOS_UUIDS) {
    assert.equal(normalizeIdentifier("smbiosUuid", uuid), null);
  }
  for (const hash of PLACEHOLDER_SMBIOS_HASHES) {
    assert.equal(isPlaceholderSmbiosHash(hash), true);
  }

  const created = createDeviceBinding(
    makeValues({ smbiosUuid: "03000200-0400-0500-0006-000700080009" })
  );
  assert.equal(created.ok, false);
  assert.equal(created.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(created.identifier, "smbiosUuid");

  const valid = createDeviceBinding(makeValues()).data;
  const placeholderBinding = {
    scheme: DEVICE_SCHEME,
    match: "all",
    identifiers: {
      machineGuid: valid.identifiers.machineGuid,
      smbiosUuid: PLACEHOLDER_SMBIOS_HASHES[0],
    },
  };
  const matched = matchDeviceBinding(placeholderBinding, makeValues());
  assert.equal(matched.ok, false);
  assert.equal(matched.code, "MALFORMED_DEVICE_BINDING");
  assert.equal(matched.identifier, "smbiosUuid");
});

test("ignores inherited identifier properties", () => {
  const binding = createDeviceBinding(makeValues()).data;
  const hadMachine = Object.prototype.hasOwnProperty.call(Object.prototype, "machineGuid");
  const hadSmbios = Object.prototype.hasOwnProperty.call(Object.prototype, "smbiosUuid");
  const previousMachine = Object.prototype.machineGuid;
  const previousSmbios = Object.prototype.smbiosUuid;

  Object.prototype.machineGuid = MACHINE_GUID;
  Object.prototype.smbiosUuid = SMBIOS_UUID;

  try {
    const created = createDeviceBinding({});
    assert.equal(created.ok, false);
    assert.equal(created.code, "IDENTIFIER_UNAVAILABLE");

    const matched = matchDeviceBinding(binding, {});
    assert.equal(matched.ok, false);
    assert.equal(matched.code, "IDENTIFIER_UNAVAILABLE");
  } finally {
    if (hadMachine) Object.prototype.machineGuid = previousMachine;
    else delete Object.prototype.machineGuid;
    if (hadSmbios) Object.prototype.smbiosUuid = previousSmbios;
    else delete Object.prototype.smbiosUuid;
  }
});

test("allows extra top-level binding metadata but not extra identifier types", () => {
  const binding = createDeviceBinding(makeValues()).data;
  binding.futureMetadata = { note: "signed metadata" };
  const accepted = matchDeviceBinding(binding, makeValues());
  assert.equal(accepted.ok, true, accepted.error);

  const withUnknownIdentifier = Object.assign({}, binding, {
    identifiers: Object.assign({}, binding.identifiers, {
      macAddress: hashIdentifier("machineGuid", MACHINE_GUID),
    }),
  });
  const rejected = matchDeviceBinding(withUnknownIdentifier, makeValues());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "MALFORMED_DEVICE_BINDING");
});

test("collects Windows identifiers only through the injected runner", async () => {
  const fake = fakeRunner(GOOD_OUTPUTS);
  const result = await collectWindowsIdentifiers({
    platform: "win32",
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.machineGuid, canonicalGuid(MACHINE_GUID));
  assert.equal(result.data.smbiosUuid, canonicalGuid(SMBIOS_UUID));
  assert.deepEqual(result.unavailable, []);
  assert.equal(Object.hasOwn(result.data, "systemVolumeSerial"), false);

  assert.equal(fake.calls.some((call) => call.file === "reg.exe"), true);
  assert.equal(fake.calls.some((call) => call.file === "powershell.exe"), true);
  assert.equal(fake.calls.some((call) => call.file === "wmic.exe"), false);

  for (const call of fake.calls) {
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, undefined);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
  }
});

test("collects the optional volume serial only when added to the required pair", async () => {
  const fake = fakeRunner(GOOD_OUTPUTS);
  const result = await collectWindowsIdentifiers({
    platform: "win32",
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.systemVolumeSerial, "1a2b3c4d");
  assert.equal(
    fake.calls.some((call) => call.args.some((arg) => arg.includes("Win32_LogicalDisk"))),
    true
  );

  const volumeOnly = await collectWindowsIdentifiers({
    platform: "win32",
    identifiers: ["systemVolumeSerial"],
    runCommand: fake.runCommand,
  });
  assert.equal(volumeOnly.ok, false);
  assert.equal(volumeOnly.code, "INVALID_IDENTIFIERS");
});

test("rejects non-Windows collection without invoking commands", async () => {
  const fake = fakeRunner(GOOD_OUTPUTS);
  const result = await collectWindowsIdentifiers({
    platform: "linux",
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_PLATFORM");
  assert.equal(fake.calls.length, 0);
});

test("marks missing or failed identifiers unavailable without leaking command output", async () => {
  const fake = fakeRunner({
    regError: "failure containing " + MACHINE_GUID,
    reg64Error: "failure containing " + MACHINE_GUID,
    smbios: "",
    smbiosError: "failure containing " + SMBIOS_UUID,
    wmic: "",
  });
  const result = await collectWindowsIdentifiers({
    platform: "win32",
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(result.identifier, "machineGuid");
  assert.deepEqual(result.unavailable, ["machineGuid", "smbiosUuid"]);
  assert.equal(Object.hasOwn(result, "data"), false);
  assertNoRawIdentifiers(result, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);

  const created = await createWindowsDeviceBinding({
    platform: "win32",
    runCommand: fake.runCommand,
  });
  assert.equal(created.ok, false);
  assert.equal(created.code, "IDENTIFIER_UNAVAILABLE");
  assertNoRawIdentifiers(created, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
});

test("reports incomplete collection when only one identifier is available", async () => {
  const fake = fakeRunner(Object.assign({}, GOOD_OUTPUTS, {
    smbiosError: "unavailable",
    smbios: "",
    wmicError: "unavailable",
    wmic: "",
  }));
  const result = await collectWindowsIdentifiers({
    platform: "win32",
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(result.identifier, "smbiosUuid");
  assert.deepEqual(result.unavailable, ["smbiosUuid"]);
  assert.equal(Object.hasOwn(result, "data"), false);
});

test("falls back from PowerShell to WMIC for SMBIOS UUID", async () => {
  const fake = fakeRunner({
    reg64: GOOD_OUTPUTS.reg64,
    smbiosError: "PowerShell unavailable",
    wmic: "\r\nUUID=" + SMBIOS_UUID + "\r\n",
  });
  const result = await collectWindowsIdentifiers({
    platform: "win32",
    runCommand: fake.runCommand,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.smbiosUuid, canonicalGuid(SMBIOS_UUID));
  assert.equal(fake.calls.some((call) => call.file === "wmic.exe"), true);
});

test("composes collection, binding creation, and strict matching", async () => {
  const fake = fakeRunner(GOOD_OUTPUTS);
  const created = await createWindowsDeviceBinding({
    platform: "win32",
    runCommand: fake.runCommand,
  });
  assert.equal(created.ok, true, created.error);
  assertNoRawIdentifiers(created, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);

  const matched = await matchWindowsDeviceBinding(created.data, {
    platform: "win32",
    runCommand: fake.runCommand,
  });
  assert.equal(matched.ok, true, matched.error);

  const changed = fakeRunner(
    Object.assign({}, GOOD_OUTPUTS, {
      reg64:
        "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n" +
        "    MachineGuid    REG_SZ    87654321-4321-4321-4321-BA0987654321\r\n\r\n",
    })
  );
  const mismatch = await matchWindowsDeviceBinding(created.data, {
    platform: "win32",
    runCommand: changed.runCommand,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "DEVICE_MISMATCH");
  assertNoRawIdentifiers(mismatch, [MACHINE_GUID, SMBIOS_UUID, VOLUME_SERIAL]);
});

test("only collects identifiers selected by the binding during matching", async () => {
  const fake = fakeRunner(GOOD_OUTPUTS);
  const created = await createWindowsDeviceBinding({
    platform: "win32",
    runCommand: fake.runCommand,
  });
  assert.equal(created.ok, true, created.error);

  const matchingFake = fakeRunner(GOOD_OUTPUTS);
  const matched = await matchWindowsDeviceBinding(created.data, {
    platform: "win32",
    runCommand: matchingFake.runCommand,
  });

  assert.equal(matched.ok, true, matched.error);
  assert.equal(
    matchingFake.calls.some((call) =>
      call.args.some((arg) => arg.includes("Win32_LogicalDisk"))
    ),
    false
  );
});
