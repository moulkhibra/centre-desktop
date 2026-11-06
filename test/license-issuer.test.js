"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { issueLicense } = require("../tools/license-issuer");
const {
  createDeviceBinding,
  hashIdentifier,
  PLACEHOLDER_SMBIOS_HASHES,
} = require("../device-fingerprint");
const {
  createTrustedKeyRegistry,
  verifyActivatedLicense,
} = require("../license-activation");
const { PRODUCT_ID } = require("../license-verification");

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

function makeOptions(keys, overrides) {
  return Object.assign({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    deviceBinding: makeBinding(makeValues()),
    licenseId: "lic-2026-0001",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
  }, overrides || {});
}

function decodePayload(envelope) {
  return JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
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

test("issues a signed device-bound license accepted by activation", () => {
  const keys = makeKeyPair();
  const values = makeValues();
  const options = makeOptions(keys, { deviceBinding: makeBinding(values) });

  const result = issueLicense(options);
  assert.equal(result.ok, true, result.error);

  const envelope = result.data;
  assert.equal(envelope.schema, "centre-license/1");
  assert.equal(envelope.alg, "Ed25519");
  assert.equal(envelope.keyId, KEY_ID);

  const payload = decodePayload(envelope);
  assert.equal(payload.product, PRODUCT_ID);
  assert.equal(payload.licenseId, "lic-2026-0001");
  assert.equal(payload.licensee, "Centre de soutien");
  assert.equal(payload.issuedAt, "2026-01-01");
  assert.equal(payload.type, "perpetual");
  assert.deepEqual(payload.device, options.deviceBinding);
  assert.equal(Object.hasOwn(payload, "notBefore"), false);

  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(Object.hasOwn(envelope, "privateKey"), false);
  assertNoRawIdentifiers(result, values);

  const registry = createTrustedKeyRegistry([
    { keyId: KEY_ID, publicKey: keys.publicKey },
  ]).data;
  const activated = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(activated.ok, true, activated.error);
  assert.deepEqual(activated.data.device, options.deviceBinding);
});

test("accepts KeyObject, PEM, and DER Ed25519 private keys", () => {
  const keys = makeKeyPair();
  const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const der = keys.privateKey.export({ type: "pkcs8", format: "der" });

  for (const privateKey of [keys.privateKey, pem, der]) {
    const result = issueLicense(makeOptions(keys, { privateKey: privateKey }));
    assert.equal(result.ok, true, result.error);
  }
});

test("rejects invalid or non-Ed25519 private keys", () => {
  const keys = makeKeyPair();
  const ecKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });

  const cases = [
    null,
    undefined,
    "not a key",
    keys.publicKey,
    publicPem,
    ecKeys.privateKey,
  ];

  for (const privateKey of cases) {
    const result = issueLicense(makeOptions(keys, { privateKey: privateKey }));
    assert.equal(result.ok, false, String(privateKey));
    assert.equal(result.code, "INVALID_PRIVATE_KEY", String(privateKey));
  }
});

test("requires the key ID, license ID, licensee, and device binding", () => {
  const keys = makeKeyPair();
  const base = makeOptions(keys);

  assert.equal(
    issueLicense(Object.assign({}, base, { privateKey: undefined })).code,
    "INVALID_PRIVATE_KEY"
  );
  assert.equal(
    issueLicense(Object.assign({}, base, { keyId: undefined })).code,
    "INVALID_KEY_ID"
  );
  assert.equal(
    issueLicense(Object.assign({}, base, { licenseId: undefined })).code,
    "INVALID_OPTIONS"
  );
  assert.equal(
    issueLicense(Object.assign({}, base, { licensee: "   " })).code,
    "INVALID_OPTIONS"
  );
  assert.equal(
    issueLicense(Object.assign({}, base, { deviceBinding: undefined })).code,
    "INVALID_DEVICE_BINDING"
  );
});

test("rejects malformed device bindings and raw identifiers", () => {
  const keys = makeKeyPair();
  const valid = makeBinding(makeValues());
  const validHash = hashIdentifier("machineGuid", MACHINE_GUID);
  const validSmbiosHash = hashIdentifier("smbiosUuid", SMBIOS_UUID);
  const validVolumeHash = hashIdentifier("systemVolumeSerial", VOLUME_SERIAL);
  const cases = [
    null,
    {},
    [],
    Object.assign({}, valid, { scheme: "other" }),
    Object.assign({}, valid, { match: "any" }),
    Object.assign({}, valid, { identifiers: null }),
    Object.assign({}, valid, { identifiers: {} }),
    Object.assign({}, valid, { identifiers: { macAddress: validHash } }),
    Object.assign({}, valid, { identifiers: { machineGuid: MACHINE_GUID } }),
    Object.assign({}, valid, { identifiers: { machineGuid: validHash.toUpperCase() } }),
    Object.assign({}, valid, { identifiers: { machineGuid: 123 } }),
    Object.assign({}, valid, { identifiers: { machineGuid: validHash } }),
    Object.assign({}, valid, { identifiers: { smbiosUuid: validSmbiosHash } }),
    Object.assign({}, valid, { identifiers: { systemVolumeSerial: validVolumeHash } }),
    Object.assign({}, valid, {
      identifiers: { machineGuid: validHash, systemVolumeSerial: validVolumeHash },
    }),
    Object.assign({}, valid, {
      identifiers: { machineGuid: validHash, smbiosUuid: PLACEHOLDER_SMBIOS_HASHES[0] },
    }),
  ];

  for (const deviceBinding of cases) {
    const result = issueLicense(makeOptions(keys, { deviceBinding: deviceBinding }));
    assert.equal(result.ok, false, JSON.stringify(deviceBinding));
    assert.equal(result.code, "INVALID_DEVICE_BINDING", JSON.stringify(deviceBinding));
    assertNoRawIdentifiers(result, makeValues());
  }
});

test("requires both machineGuid and smbiosUuid for issuance", () => {
  const keys = makeKeyPair();
  const valid = makeBinding(makeValues());
  const machineOnly = {
    scheme: valid.scheme,
    match: "all",
    identifiers: { machineGuid: valid.identifiers.machineGuid },
  };
  const smbiosOnly = {
    scheme: valid.scheme,
    match: "all",
    identifiers: { smbiosUuid: valid.identifiers.smbiosUuid },
  };
  const placeholder = {
    scheme: valid.scheme,
    match: "all",
    identifiers: {
      machineGuid: valid.identifiers.machineGuid,
      smbiosUuid: PLACEHOLDER_SMBIOS_HASHES[0],
    },
  };

  for (const deviceBinding of [machineOnly, smbiosOnly, placeholder]) {
    const result = issueLicense(makeOptions(keys, { deviceBinding: deviceBinding }));
    assert.equal(result.ok, false, JSON.stringify(deviceBinding));
    assert.equal(result.code, "INVALID_DEVICE_BINDING", JSON.stringify(deviceBinding));
  }
});

test("drops extra binding metadata and canonicalizes identifier order", () => {
  const keys = makeKeyPair();
  const binding = makeBinding(makeValues());
  const input = {
    scheme: binding.scheme,
    match: binding.match,
    identifiers: {
      smbiosUuid: binding.identifiers.smbiosUuid,
      machineGuid: binding.identifiers.machineGuid,
    },
    rawMachineGuid: MACHINE_GUID,
    note: "must not be signed",
  };

  const result = issueLicense(makeOptions(keys, { deviceBinding: input }));
  assert.equal(result.ok, true, result.error);

  const payload = decodePayload(result.data);
  assert.deepEqual(Object.keys(payload.device.identifiers), [
    "machineGuid",
    "smbiosUuid",
  ]);
  assert.equal(Object.hasOwn(payload.device, "rawMachineGuid"), false);
  assert.equal(Object.hasOwn(payload.device, "note"), false);
  assert.equal(JSON.stringify(payload).includes(MACHINE_GUID), false);
});

test("rejects invalid license fields through self-verification", () => {
  const keys = makeKeyPair();
  const base = makeOptions(keys);

  const cases = [
    [{ licenseId: "bad id" }, "INVALID_LICENSE_ID"],
    [{ licenseId: "a".repeat(129) }, "INVALID_LICENSE_ID"],
    [{ licensee: "Bad\u0000Name" }, "INVALID_LICENSEE"],
    [{ licensee: "a".repeat(257) }, "INVALID_LICENSEE"],
    [{ issuedAt: "2026-02-30" }, "INVALID_ISSUED_AT"],
    [{ issuedAt: "2026-1-1" }, "INVALID_ISSUED_AT"],
    [{ notBefore: "2026-02-30" }, "INVALID_NOT_BEFORE"],
    [{ notBefore: true }, "INVALID_NOT_BEFORE"],
  ];

  for (const [overrides, code] of cases) {
    const result = issueLicense(Object.assign({}, base, overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.code, code, JSON.stringify(overrides));
  }
});

test("rejects malformed key IDs", () => {
  const keys = makeKeyPair();

  for (const keyId of ["", "bad key id", "a".repeat(65), 42]) {
    const result = issueLicense(makeOptions(keys, { keyId: keyId }));
    assert.equal(result.ok, false, String(keyId));
    assert.equal(result.code, "INVALID_KEY_ID", String(keyId));
  }
});

test("supports optional, null, current, and future not-before dates", () => {
  const keys = makeKeyPair();
  const registry = createTrustedKeyRegistry([
    { keyId: KEY_ID, publicKey: keys.publicKey },
  ]).data;
  const values = makeValues();

  const omitted = issueLicense(makeOptions(keys));
  assert.equal(omitted.ok, true, omitted.error);
  assert.equal(Object.hasOwn(decodePayload(omitted.data), "notBefore"), false);

  const nulled = issueLicense(makeOptions(keys, { notBefore: null }));
  assert.equal(nulled.ok, true, nulled.error);
  assert.equal(decodePayload(nulled.data).notBefore, null);

  const current = issueLicense(makeOptions(keys, { notBefore: "2026-01-01" }));
  assert.equal(current.ok, true, current.error);
  const currentActivated = verifyActivatedLicense(current.data, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(currentActivated.ok, true, currentActivated.error);

  const future = issueLicense(makeOptions(keys, { notBefore: "2027-01-01" }));
  assert.equal(future.ok, true, future.error);
  const futureActivated = verifyActivatedLicense(future.data, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(futureActivated.ok, false);
  assert.equal(futureActivated.code, "NOT_YET_VALID");
});
