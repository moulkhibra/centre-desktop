"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { issueLicense } = require("../tools/license-issuer");
const { createDeviceBinding } = require("../device-fingerprint");
const { createTrustedKeyRegistry } = require("../license-activation");
const {
  LICENSE_FILE_NAME,
  writeLicenseFile,
} = require("../license-store");
const {
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
} = require("../license-verification");
const { verifyStartupLicense } = require("../startup-license");

const NOW = new Date("2026-06-15T12:00:00Z");
const KEY_ID = "test-key-1";
const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const VOLUME_SERIAL = "1A2B3C4D";
const OTHER_MACHINE_GUID = "87654321-4321-4321-4321-BA0987654321";

function makeValues(overrides) {
  return Object.assign({
    machineGuid: MACHINE_GUID,
    smbiosUuid: SMBIOS_UUID,
    systemVolumeSerial: VOLUME_SERIAL,
  }, overrides || {});
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-startup-license-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const keys = crypto.generateKeyPairSync("ed25519");
  const values = makeValues();
  // The default fixture binding is the required-only pair; the volume serial is
  // available on the device but only selected by volume-specific tests.
  const binding = createDeviceBinding(values).data;
  const registry = createTrustedKeyRegistry([
    { keyId: KEY_ID, publicKey: keys.publicKey },
  ]).data;

  return {
    root: root,
    dataDir: path.join(root, "Documents", "CentreData"),
    userDataDir: path.join(root, "profile"),
    storageDir: path.join(root, "profile", "license"),
    keys: keys,
    values: values,
    binding: binding,
    registry: registry,
  };
}

// Simulates the real collector: only the identifiers named by the verified
// signed binding are returned, and every invocation is recorded.
function makeCollector(fixture, calls) {
  return async function (options) {
    const identifiers =
      options && Array.isArray(options.identifiers) ? options.identifiers.slice() : [];
    if (calls) calls.push({ identifiers: identifiers, platform: options && options.platform });
    const data = {};
    for (const identifier of identifiers) {
      if (Object.prototype.hasOwnProperty.call(fixture.values, identifier)) {
        data[identifier] = fixture.values[identifier];
      }
    }
    return { ok: true, data: data };
  };
}

function makeOptions(fixture, overrides) {
  return Object.assign({
    dataDir: fixture.dataDir,
    userDataDir: fixture.userDataDir,
    registryFactory: function () {
      return { ok: true, data: fixture.registry };
    },
    collectIdentifiers: makeCollector(fixture),
    now: NOW,
  }, overrides || {});
}

function issue(fixture, overrides) {
  const result = issueLicense(Object.assign({
    privateKey: fixture.keys.privateKey,
    keyId: KEY_ID,
    deviceBinding: fixture.binding,
    licenseId: "lic-2026-startup-1",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
  }, overrides || {}));
  assert.equal(result.ok, true, result.error);
  return result.data;
}

async function writeLicense(fixture, envelope, deviceIdentifiers) {
  const result = await writeLicenseFile(fixture.storageDir, envelope, {
    protectedDataDir: fixture.dataDir,
    registry: fixture.registry,
    deviceIdentifiers: deviceIdentifiers || fixture.values,
    now: NOW,
  });
  assert.equal(result.ok, true, result.error);
  return result;
}

// Seeds a license through the filesystem for negative startup-gate cases that
// the verified writer correctly refuses to install.
function writeRawLicense(fixture, envelope) {
  fs.mkdirSync(fixture.storageDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.storageDir, LICENSE_FILE_NAME),
    JSON.stringify(envelope, null, 2) + "\n",
    "utf8"
  );
}

function makePayload(device, overrides) {
  return Object.assign({
    product: PRODUCT_ID,
    licenseId: "lic-2026-startup-raw",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
    type: "perpetual",
    device: device,
  }, overrides || {});
}

function signPayload(fixture, payload, keyId) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: keyId === undefined ? KEY_ID : keyId,
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, fixture.keys.privateKey).toString("base64url"),
  };
}

function snapshot(root) {
  if (!fs.existsSync(root)) return null;
  return {
    entries: fs.readdirSync(root).sort(),
    files: fs.readdirSync(root).sort().map((name) => {
      const absolute = path.join(root, name);
      return [name, fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : null];
    }),
  };
}

test("fails closed with no production key before touching identifiers or the filesystem", async (t) => {
  const fixture = makeFixture(t);
  let collected = false;

  const result = await verifyStartupLicense({
    dataDir: fixture.dataDir,
    userDataDir: fixture.userDataDir,
    collectIdentifiers: async function () {
      collected = true;
      return { ok: true, data: fixture.values };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PRODUCTION_KEY_NOT_CONFIGURED");
  assert.equal(collected, false);
  assert.equal(fs.existsSync(fixture.dataDir), false);
  assert.equal(fs.existsSync(fixture.storageDir), false);
});

test("requires absolute protected data and user data directories", async () => {
  assert.equal(
    (await verifyStartupLicense({ dataDir: "relative", userDataDir: "/tmp/profile" })).code,
    "INVALID_OPTIONS"
  );
  assert.equal(
    (await verifyStartupLicense({ dataDir: "/tmp/data", userDataDir: "" })).code,
    "INVALID_OPTIONS"
  );
  assert.equal((await verifyStartupLicense({})).code, "INVALID_OPTIONS");
});

test("reports a missing license without creating protected data or storage directories", async (t) => {
  const fixture = makeFixture(t);

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "LICENSE_MISSING");
  assert.equal(fs.existsSync(fixture.dataDir), false);
  assert.equal(fs.existsSync(fixture.storageDir), false);
});

test("preserves a sentinel data directory when the license is missing", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.dataDir, "centre-data.json"), "sentinel-data", "utf8");
  const before = snapshot(fixture.dataDir);

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.code, "LICENSE_MISSING");
  assert.deepEqual(snapshot(fixture.dataDir), before);
  assert.equal(fs.existsSync(fixture.storageDir), false);
});

test("preserves a sentinel data directory when the license is invalid", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.dataDir, "centre-data.json"), "sentinel-data", "utf8");
  fs.mkdirSync(fixture.storageDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.storageDir, "license.json"), "not json", "utf8");
  const before = snapshot(fixture.dataDir);

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "LICENSE_INVALID");
  assert.deepEqual(snapshot(fixture.dataDir), before);
});

test("accepts a valid license without creating the protected data directory", async (t) => {
  const fixture = makeFixture(t);
  await writeLicense(fixture, issue(fixture));

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.license.licenseId, "lic-2026-startup-1");
  assert.equal(result.data.directory, path.resolve(fixture.storageDir));
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test("rejects a license bound to another device", async (t) => {
  const fixture = makeFixture(t);
  const otherValues = makeValues({ machineGuid: OTHER_MACHINE_GUID });
  const otherBinding = createDeviceBinding(otherValues).data;
  await writeLicense(
    fixture,
    issue(fixture, { deviceBinding: otherBinding }),
    otherValues
  );

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "DEVICE_MISMATCH");
  assert.equal(result.identifier, "machineGuid");
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test("rejects a license signed by an attacker key", async (t) => {
  const fixture = makeFixture(t);
  const attacker = crypto.generateKeyPairSync("ed25519");
  writeRawLicense(
    fixture,
    issue(fixture, { privateKey: attacker.privateKey })
  );

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "LICENSE_INVALID");
  assert.equal(result.cause, "INVALID_SIGNATURE");
});

test("rejects a license that is not yet valid", async (t) => {
  const fixture = makeFixture(t);
  writeRawLicense(fixture, issue(fixture, { notBefore: "2099-01-01" }));

  const result = await verifyStartupLicense(makeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "LICENSE_INVALID");
  assert.equal(result.cause, "NOT_YET_VALID");
});

test("propagates incomplete device identifier collection for a verified license", async (t) => {
  const fixture = makeFixture(t);
  await writeLicense(fixture, issue(fixture));
  let collected = false;

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: async function () {
      collected = true;
      return {
        ok: false,
        code: "IDENTIFIER_UNAVAILABLE",
        error: "unavailable",
        identifier: "smbiosUuid",
        unavailable: ["smbiosUuid"],
      };
    },
  }));

  assert.equal(collected, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(result.identifier, "smbiosUuid");
  assert.deepEqual(result.unavailable, ["smbiosUuid"]);
});

test("collects only the identifiers required by a required-only signed binding", async (t) => {
  const fixture = makeFixture(t);
  await writeLicense(fixture, issue(fixture));
  const calls = [];

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: makeCollector(fixture, calls),
  }));

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls, [{ identifiers: ["machineGuid", "smbiosUuid"], platform: undefined }]);
});

test("collects the optional volume serial only when it is in the signed binding", async (t) => {
  const fixture = makeFixture(t);
  const volumeBinding = createDeviceBinding(fixture.values, {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  }).data;
  await writeLicense(
    fixture,
    issue(fixture, { deviceBinding: volumeBinding, licenseId: "lic-2026-volume" })
  );
  const calls = [];

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: makeCollector(fixture, calls),
  }));

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.license.licenseId, "lic-2026-volume");
  assert.deepEqual(calls, [{
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
    platform: undefined,
  }]);
});

test("fails closed when the signed optional volume serial is unavailable", async (t) => {
  const fixture = makeFixture(t);
  const volumeBinding = createDeviceBinding(fixture.values, {
    identifiers: ["machineGuid", "smbiosUuid", "systemVolumeSerial"],
  }).data;
  await writeLicense(fixture, issue(fixture, { deviceBinding: volumeBinding }));

  const valuesWithoutVolume = makeValues();
  delete valuesWithoutVolume.systemVolumeSerial;

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: makeCollector({ values: valuesWithoutVolume }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(result.identifier, "systemVolumeSerial");
});

test("verifies the signed envelope before collecting any identifier", async (t) => {
  const fixture = makeFixture(t);
  const tampered = issue(fixture);
  const signature = Buffer.from(tampered.signature, "base64url");
  signature[0] ^= 0xff;
  tampered.signature = signature.toString("base64url");
  writeRawLicense(fixture, tampered);
  let collected = false;

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: async function () {
      collected = true;
      return { ok: true, data: fixture.values };
    },
  }));

  assert.equal(collected, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "LICENSE_INVALID");
  assert.equal(result.cause, "INVALID_SIGNATURE");
});

test("rejects incomplete or weaker signed bindings before collecting identifiers", async (t) => {
  const fixture = makeFixture(t);
  const incomplete = JSON.parse(JSON.stringify(fixture.binding));
  delete incomplete.identifiers.smbiosUuid;
  writeRawLicense(fixture, signPayload(fixture, makePayload(incomplete)));
  let collected = false;

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: async function () {
      collected = true;
      return { ok: true, data: fixture.values };
    },
  }));

  assert.equal(collected, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "MALFORMED_DEVICE_BINDING");
  assert.equal(result.identifier, "smbiosUuid");
});

test("rejects a license directory that overlaps the protected data directory", async (t) => {
  const fixture = makeFixture(t);
  const overlappingUserData = path.join(fixture.dataDir, "profile");

  const result = await verifyStartupLicense(makeOptions(fixture, {
    userDataDir: overlappingUserData,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSAFE_LICENSE_STORAGE");
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test("passes the real protected data directory and trusted registry to the loader", async (t) => {
  const fixture = makeFixture(t);
  const collector = makeCollector(fixture);
  let received = null;

  const result = await verifyStartupLicense(makeOptions(fixture, {
    collectIdentifiers: collector,
    loadLicense: async function (options) {
      received = options;
      return { ok: true, data: { licenseId: "injected-license" } };
    },
  }));

  assert.equal(result.ok, true, result.error);
  assert.equal(received.protectedDataDir, fixture.dataDir);
  assert.equal(received.storageDir, path.resolve(fixture.storageDir));
  assert.equal(received.registry, fixture.registry);
  assert.equal(received.collectIdentifiers, collector);
  assert.equal(received.platform, undefined);
  assert.equal(received.now, NOW);
});
