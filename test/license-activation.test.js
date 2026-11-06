"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createTrustedKeyRegistry,
  verifyActivatedLicenseSignature,
  verifyActivatedLicense,
} = require("../license-activation");
const {
  createDeviceBinding,
  hashIdentifier,
  PLACEHOLDER_SMBIOS_HASHES,
} = require("../device-fingerprint");
const {
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
} = require("../license-verification");

const NOW = new Date("2026-06-15T12:00:00Z");
const KEY_ID = "test-key-1";
const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const VOLUME_SERIAL = "1A2B3C4D";

function makeKeyPair() {
  return crypto.generateKeyPairSync("ed25519");
}

function makeValues(overrides) {
  return Object.assign({
    machineGuid: MACHINE_GUID,
    smbiosUuid: SMBIOS_UUID,
    systemVolumeSerial: VOLUME_SERIAL,
  }, overrides || {});
}

function makeBinding(values, options) {
  const result = createDeviceBinding(values, options);
  assert.equal(result.ok, true, result.error);
  return result.data;
}

function makePayload(device, overrides) {
  return Object.assign({
    product: PRODUCT_ID,
    licenseId: "lic-2026-0001",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
    notBefore: "2026-01-01",
    type: "perpetual",
    device: device,
  }, overrides || {});
}

function makeEnvelope(payload, privateKey, keyId) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: keyId === undefined ? KEY_ID : keyId,
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, privateKey).toString("base64url"),
  };
}

function makeRegistry(entries) {
  const result = createTrustedKeyRegistry(entries);
  assert.equal(result.ok, true, result.error);
  return result.data;
}

function assertNoRawIdentifiers(value, values) {
  const serialized = JSON.stringify(value);
  for (const raw of Object.values(values || makeValues())) {
    if (typeof raw !== "string") continue;
    assert.equal(serialized.includes(raw), false, "raw identifier leaked: " + raw);
    assert.equal(
      serialized.includes(raw.replace(/[{}\s-]/g, "").toLowerCase()),
      false,
      "raw identifier leaked: " + raw
    );
  }
}

test("accepts a signed license bound to the matching device", () => {
  const keys = makeKeyPair();
  const values = makeValues();
  const binding = makeBinding(values);
  const payload = makePayload(binding);
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);

  const result = verifyActivatedLicense(makeEnvelope(payload, keys.privateKey), {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.product, PRODUCT_ID);
  assert.equal(result.data.licenseId, "lic-2026-0001");
  assert.equal(result.data.licensee, "Centre de soutien");
  assert.deepEqual(result.data.device, binding);
  assertNoRawIdentifiers(result, values);
});

test("verifies a signature and reports signed binding identifiers without device data", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const values = makeValues();

  const requiredOnly = makeBinding(values);
  const requiredResult = verifyActivatedLicenseSignature(
    makeEnvelope(makePayload(requiredOnly), keys.privateKey),
    { registry: registry, now: NOW }
  );
  assert.equal(requiredResult.ok, true, requiredResult.error);
  assert.deepEqual(requiredResult.identifiers, ["machineGuid", "smbiosUuid"]);

  const withVolume = makeBinding(values, {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  });
  const volumeResult = verifyActivatedLicenseSignature(
    makeEnvelope(makePayload(withVolume), keys.privateKey),
    { registry: registry, now: NOW }
  );
  assert.equal(volumeResult.ok, true, volumeResult.error);
  assert.deepEqual(volumeResult.identifiers, [
    "machineGuid",
    "smbiosUuid",
    "systemVolumeSerial",
  ]);

  // Binding fields are not trusted until the envelope signature is verified.
  const envelope = makeEnvelope(makePayload(requiredOnly), keys.privateKey);
  const otherBinding = makeBinding(
    makeValues({ machineGuid: "87654321-4321-4321-4321-BA0987654321" })
  );
  const tampered = Object.assign({}, envelope, {
    payload: Buffer.from(JSON.stringify(makePayload(otherBinding)), "utf8").toString("base64url"),
  });
  const tamperedResult = verifyActivatedLicenseSignature(tampered, {
    registry: registry,
    now: NOW,
  });
  assert.equal(tamperedResult.ok, false);
  assert.equal(tamperedResult.code, "INVALID_SIGNATURE");
  assert.equal(tamperedResult.identifiers, undefined);
});

test("rejects a signed license with a null device binding", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);

  const nullDevice = verifyActivatedLicense(
    makeEnvelope(makePayload(null), keys.privateKey),
    { registry: registry, now: NOW, deviceIdentifiers: makeValues() }
  );
  assert.equal(nullDevice.ok, false);
  assert.equal(nullDevice.code, "DEVICE_REQUIRED");

  // A tampered null-device payload must fail signature verification first,
  // not fall through to DEVICE_REQUIRED.
  const bound = makeEnvelope(makePayload(makeBinding(makeValues())), keys.privateKey);
  const tamperedNull = Object.assign({}, bound, {
    payload: Buffer.from(JSON.stringify(makePayload(null)), "utf8").toString("base64url"),
  });
  const tampered = verifyActivatedLicense(tamperedNull, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues(),
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, "INVALID_SIGNATURE");
});

test("selects a trusted key by keyId and rejects unknown or wrong key IDs", () => {
  const keyA = makeKeyPair();
  const keyB = makeKeyPair();
  const registry = makeRegistry([
    { keyId: "key-a", publicKey: keyA.publicKey },
    { keyId: "key-b", publicKey: keyB.publicKey },
  ]);
  const values = makeValues();
  const payload = makePayload(makeBinding(values));
  const options = { registry: registry, now: NOW, deviceIdentifiers: values };

  const accepted = verifyActivatedLicense(
    makeEnvelope(payload, keyA.privateKey, "key-a"),
    options
  );
  assert.equal(accepted.ok, true, accepted.error);

  const unknown = verifyActivatedLicense(
    makeEnvelope(payload, keyA.privateKey, "key-c"),
    options
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "UNKNOWN_KEY_ID");

  const wrongKey = verifyActivatedLicense(
    makeEnvelope(payload, keyA.privateKey, "key-b"),
    options
  );
  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.code, "INVALID_SIGNATURE");

  const malformedKeyId = verifyActivatedLicense(
    makeEnvelope(payload, keyA.privateKey, "bad key id"),
    options
  );
  assert.equal(malformedKeyId.ok, false);
  assert.equal(malformedKeyId.code, "MALFORMED_ENVELOPE");
});

test("rejects invalid signatures and device bindings tampered after signing", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const values = makeValues();
  const binding = makeBinding(values);
  const envelope = makeEnvelope(makePayload(binding), keys.privateKey);
  const options = { registry: registry, now: NOW, deviceIdentifiers: values };

  const signatureBytes = Buffer.from(envelope.signature, "base64url");
  signatureBytes[0] ^= 0xff;
  const badSignature = verifyActivatedLicense(
    Object.assign({}, envelope, { signature: signatureBytes.toString("base64url") }),
    options
  );
  assert.equal(badSignature.ok, false);
  assert.equal(badSignature.code, "INVALID_SIGNATURE");

  const otherBinding = makeBinding(
    makeValues({ machineGuid: "87654321-4321-4321-4321-BA0987654321" })
  );
  const tamperedDevice = verifyActivatedLicense(
    Object.assign({}, envelope, {
      payload: Buffer.from(JSON.stringify(makePayload(otherBinding)), "utf8").toString("base64url"),
    }),
    options
  );
  assert.equal(tamperedDevice.ok, false);
  assert.equal(tamperedDevice.code, "INVALID_SIGNATURE");
});

test("rejects a license bound to a different device", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const binding = makeBinding(makeValues());
  const envelope = makeEnvelope(makePayload(binding), keys.privateKey);

  const changedMachine = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues({
      machineGuid: "87654321-4321-4321-4321-BA0987654321",
    }),
  });
  assert.equal(changedMachine.ok, false);
  assert.equal(changedMachine.code, "DEVICE_MISMATCH");
  assert.equal(changedMachine.identifier, "machineGuid");
  assertNoRawIdentifiers(changedMachine, makeValues());

  const changedSmbios = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues({
      smbiosUuid: "11111111-2222-3333-4444-555555555555",
    }),
  });
  assert.equal(changedSmbios.ok, false);
  assert.equal(changedSmbios.code, "DEVICE_MISMATCH");
  assert.equal(changedSmbios.identifier, "smbiosUuid");
});

test("fails closed when a required device identifier is unavailable", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const binding = makeBinding(makeValues());
  const envelope = makeEnvelope(makePayload(binding), keys.privateKey);

  const missingSmbios = makeValues();
  delete missingSmbios.smbiosUuid;
  const absent = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: missingSmbios,
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(absent.identifier, "smbiosUuid");

  const unavailable = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues({ machineGuid: null }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(unavailable.identifier, "machineGuid");
});

test("rejects malformed signed device bindings", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const validHash = hashIdentifier("machineGuid", MACHINE_GUID);
  const validSmbiosHash = hashIdentifier("smbiosUuid", SMBIOS_UUID);
  const validVolumeHash = hashIdentifier("systemVolumeSerial", VOLUME_SERIAL);
  const values = makeValues();
  const cases = [
    {},
    { scheme: "centre-device/1", match: "any", identifiers: { machineGuid: validHash } },
    { scheme: "centre-device/1", match: "all", identifiers: {} },
    { scheme: "centre-device/1", match: "all", identifiers: { macAddress: validHash } },
    { scheme: "centre-device/1", match: "all", identifiers: { machineGuid: "sha256:xyz" } },
    { scheme: "centre-device/1", match: "all", identifiers: { machineGuid: validHash } },
    {
      scheme: "centre-device/1",
      match: "all",
      identifiers: { machineGuid: validHash, smbiosUuid: validSmbiosHash.toUpperCase() },
    },
    {
      scheme: "centre-device/1",
      match: "all",
      identifiers: { machineGuid: validHash, systemVolumeSerial: validVolumeHash },
    },
    {
      scheme: "centre-device/1",
      match: "all",
      identifiers: { machineGuid: validHash, smbiosUuid: PLACEHOLDER_SMBIOS_HASHES[0] },
    },
  ];

  for (const device of cases) {
    const result = verifyActivatedLicense(
      makeEnvelope(makePayload(device), keys.privateKey),
      { registry: registry, now: NOW, deviceIdentifiers: values }
    );
    assert.equal(result.ok, false, JSON.stringify(device));
    assert.equal(result.code, "MALFORMED_DEVICE_BINDING", JSON.stringify(device));
    assertNoRawIdentifiers(result, values);
  }
});

test("ignores current identifiers that are not selected by the signed binding", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const values = makeValues();
  const binding = makeBinding(values);
  const envelope = makeEnvelope(makePayload(binding), keys.privateKey);

  const result = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues({
      systemVolumeSerial: "DEADBEEF",
      futureIdentifier: "ignored",
    }),
  });
  assert.equal(result.ok, true, result.error);
});

test("supports serialized envelopes and the optional volume serial binding", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const values = makeValues();
  const binding = makeBinding(values, {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  });
  const envelope = makeEnvelope(makePayload(binding), keys.privateKey);

  const accepted = verifyActivatedLicense(JSON.stringify(envelope), {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(accepted.ok, true, accepted.error);

  const changedVolume = verifyActivatedLicense(JSON.stringify(envelope), {
    registry: registry,
    now: NOW,
    deviceIdentifiers: makeValues({ systemVolumeSerial: "DEADBEEF" }),
  });
  assert.equal(changedVolume.ok, false);
  assert.equal(changedVolume.code, "DEVICE_MISMATCH");
  assert.equal(changedVolume.identifier, "systemVolumeSerial");
});

test("builds a trusted key registry keyed by key ID", () => {
  const keyA = makeKeyPair();
  const keyB = makeKeyPair();

  const fromArray = createTrustedKeyRegistry([
    { keyId: "key-a", publicKey: keyA.publicKey },
    { keyId: "key-b", publicKey: keyB.publicKey },
  ]);
  assert.equal(fromArray.ok, true, fromArray.error);
  assert.deepEqual(fromArray.data.keyIds(), ["key-a", "key-b"]);
  assert.equal(fromArray.data.size, 2);
  assert.equal(fromArray.data.has("key-a"), true);
  assert.equal(fromArray.data.has("key-c"), false);
  assert.equal(fromArray.data.get("key-a").type, "public");

  const fromObject = createTrustedKeyRegistry({
    "key-a": keyA.publicKey.export({ type: "spki", format: "pem" }),
    "key-b": keyB.publicKey.export({ type: "spki", format: "der" }),
  });
  assert.equal(fromObject.ok, true, fromObject.error);
  assert.deepEqual(fromObject.data.keyIds(), ["key-a", "key-b"]);

  const fromMap = createTrustedKeyRegistry(new Map([["key-a", keyA.publicKey]]));
  assert.equal(fromMap.ok, true, fromMap.error);
  assert.deepEqual(fromMap.data.keyIds(), ["key-a"]);
});

test("rejects invalid trusted key registries", () => {
  const keys = makeKeyPair();
  const ecKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });

  const cases = [
    undefined,
    null,
    [],
    {},
    "keys",
    [{ keyId: "key-a" }],
    [{ publicKey: keys.publicKey }],
    [{ keyId: "bad key id", publicKey: keys.publicKey }],
    [
      { keyId: "key-a", publicKey: keys.publicKey },
      { keyId: "key-a", publicKey: keys.publicKey },
    ],
    [{ keyId: "key-a", publicKey: "not a key" }],
    [{ keyId: "key-a", publicKey: keys.privateKey }],
    [{ keyId: "key-a", publicKey: privatePem }],
    [{ keyId: "key-a", publicKey: ecKeys.publicKey }],
  ];

  for (const entries of cases) {
    const result = createTrustedKeyRegistry(entries);
    assert.equal(result.ok, false, String(entries));
    assert.equal(result.code, "INVALID_KEY_REGISTRY", String(entries));
  }
});

test("requires a trusted registry and current device identifiers", () => {
  const keys = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: keys.publicKey }]);
  const values = makeValues();
  const envelope = makeEnvelope(makePayload(makeBinding(values)), keys.privateKey);

  const missingRegistry = verifyActivatedLicense(envelope, {
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(missingRegistry.code, "INVALID_OPTIONS");

  const malformedRegistry = verifyActivatedLicense(envelope, {
    registry: {},
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(malformedRegistry.code, "INVALID_OPTIONS");

  const fakeRegistry = verifyActivatedLicense(envelope, {
    registry: {
      has: () => true,
      get: () => keys.publicKey,
      keyIds: () => [KEY_ID],
      size: 1,
    },
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(fakeRegistry.code, "INVALID_OPTIONS");

  const missingIdentifiers = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
  });
  assert.equal(missingIdentifiers.code, "INVALID_OPTIONS");

  const arrayIdentifiers = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: [],
  });
  assert.equal(arrayIdentifiers.code, "INVALID_OPTIONS");
});

test("rejects a license signed by an attacker key against the trusted registry", () => {
  const owner = makeKeyPair();
  const attacker = makeKeyPair();
  const registry = makeRegistry([{ keyId: KEY_ID, publicKey: owner.publicKey }]);
  const values = makeValues();
  const binding = makeBinding(values);
  const payload = makePayload(binding);

  const forged = makeEnvelope(payload, attacker.privateKey, KEY_ID);
  const result = verifyActivatedLicense(forged, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SIGNATURE");
  assertNoRawIdentifiers(result, values);
});
