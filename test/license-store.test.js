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
  resolveLicenseStorage,
  validateLicenseEnvelope,
  readLicenseFile,
  writeLicenseFile,
  loadActivatedLicense,
} = require("../license-store");
const {
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
  MAX_LICENSE_BYTES,
} = require("../license-verification");

const NOW = new Date("2026-06-15T12:00:00Z");
const KEY_ID = "test-key-1";
const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";
const VOLUME_SERIAL = "1A2B3C4D";
const OTHER_MACHINE_GUID = "87654321-4321-4321-4321-BA0987654321";

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
    type: "perpetual",
    device: device,
  }, overrides || {});
}

function signEnvelope(payload, privateKey, keyId) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: keyId === undefined ? KEY_ID : keyId,
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, privateKey).toString("base64url"),
  };
}

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-license-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFixture(t, overrides) {
  const root = makeTempRoot(t);
  const dataDir = path.join(root, "Documents", "CentreData");
  const keys = makeKeyPair();
  const values = makeValues();
  const binding = makeBinding(values);
  const issued = issueLicense(Object.assign({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    deviceBinding: binding,
    licenseId: "lic-2026-0001",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
  }, overrides || {}));
  assert.equal(issued.ok, true, issued.error);

  return {
    root: root,
    dataDir: dataDir,
    storageDir: path.join(root, "license"),
    keys: keys,
    values: values,
    binding: binding,
    envelope: issued.data,
    registry: createTrustedKeyRegistry([
      { keyId: KEY_ID, publicKey: keys.publicKey },
    ]).data,
  };
}

function storageOptions(fixture) {
  return { protectedDataDir: fixture.dataDir };
}

function writeOptions(fixture, overrides) {
  return Object.assign({
    protectedDataDir: fixture.dataDir,
    registry: fixture.registry,
    now: NOW,
    deviceIdentifiers: fixture.values,
  }, overrides || {});
}

function loadOptions(fixture, overrides) {
  return Object.assign({
    storageDir: fixture.storageDir,
    protectedDataDir: fixture.dataDir,
    registry: fixture.registry,
    now: NOW,
    deviceIdentifiers: fixture.values,
  }, overrides || {});
}

// Seeds raw license bytes for negative loader tests. The verified writer below
// is intentionally unable to install these invalid licenses.
function writeRawLicense(fixture, envelope) {
  fs.mkdirSync(fixture.storageDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.storageDir, LICENSE_FILE_NAME),
    typeof envelope === "string" ? envelope : JSON.stringify(envelope, null, 2) + "\n",
    "utf8"
  );
}

function readLicenseText(fixture) {
  return fs.readFileSync(path.join(fixture.storageDir, LICENSE_FILE_NAME), "utf8");
}

function tempFiles(fixture) {
  return fs.readdirSync(fixture.storageDir).filter((name) => name.endsWith(".tmp"));
}

test("rejects storage paths that overlap the protected data directory", (t) => {
  const root = makeTempRoot(t);
  const dataDir = path.join(root, "Documents", "CentreData");

  const cases = [
    dataDir,
    path.join(dataDir, "license"),
    path.join(root, "Documents"),
    root,
  ];

  for (const storageDir of cases) {
    const result = resolveLicenseStorage(storageDir, { protectedDataDir: dataDir });
    assert.equal(result.ok, false, storageDir);
    assert.equal(result.code, "UNSAFE_LICENSE_STORAGE", storageDir);
  }

  // A protected directory nested inside the storage directory is also an overlap.
  const nestedData = path.join(root, "license", "protected");
  const nested = resolveLicenseStorage(root, { protectedDataDir: nestedData });
  assert.equal(nested.ok, false);
  assert.equal(nested.code, "UNSAFE_LICENSE_STORAGE");

  // The hardcoded CentreData segment is rejected before touching the filesystem.
  const hardcoded = path.join(os.homedir(), "Documents", "CentreData");
  assert.equal(
    resolveLicenseStorage(hardcoded, { protectedDataDir: dataDir }).code,
    "UNSAFE_LICENSE_STORAGE"
  );

  assert.equal(resolveLicenseStorage("relative/license", { protectedDataDir: dataDir }).code, "UNSAFE_LICENSE_STORAGE");
  assert.equal(resolveLicenseStorage("", { protectedDataDir: dataDir }).code, "INVALID_OPTIONS");

  const safe = resolveLicenseStorage(path.join(root, "safe-license"), {
    protectedDataDir: dataDir,
  });
  assert.equal(safe.ok, true, safe.error);
  assert.equal(safe.data.file, path.join(safe.data.directory, LICENSE_FILE_NAME));
});

test("requires the actual protected data directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-license-store-"));
  try {
    assert.equal(resolveLicenseStorage(path.join(root, "license")).code, "INVALID_OPTIONS");
    assert.equal(
      resolveLicenseStorage(path.join(root, "license"), { protectedDataDir: "relative" }).code,
      "INVALID_OPTIONS"
    );
    assert.equal(
      resolveLicenseStorage(path.join(root, "license"), { protectedDataDir: "" }).code,
      "INVALID_OPTIONS"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a redirected Documents directory supplied by the caller", async (t) => {
  const fixture = makeFixture(t);
  // Simulate redirected Documents: the real data directory is not under the
  // current user's home and is only known through the explicit option.
  const redirectedData = path.join(fixture.root, "RedirectedDocs", "CentreData");
  const options = { protectedDataDir: redirectedData };

  const resolved = resolveLicenseStorage(fixture.storageDir, options);
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.data.protectedDataDir, path.resolve(redirectedData));

  const write = await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture, {
    protectedDataDir: redirectedData,
  }));
  assert.equal(write.ok, true, write.error);
  assert.equal(fs.existsSync(redirectedData), false);

  const loaded = await loadActivatedLicense(loadOptions(fixture, {
    protectedDataDir: redirectedData,
  }));
  assert.equal(loaded.ok, true, loaded.error);
});

test("writes and reads a license file in a dedicated directory", async (t) => {
  const fixture = makeFixture(t);

  const write = await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, true, write.error);
  assert.equal(write.data.path, path.join(fixture.storageDir, LICENSE_FILE_NAME));
  assert.equal(fs.existsSync(write.data.path), true);

  const read = await readLicenseFile(fixture.storageDir, storageOptions(fixture));
  assert.equal(read.ok, true, read.error);
  assert.deepEqual(JSON.parse(read.data), fixture.envelope);

  const leftover = fs.readdirSync(fixture.storageDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftover, []);
});

test("loads a valid license bound to the current device", async (t) => {
  const fixture = makeFixture(t);
  await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));

  const result = await loadActivatedLicense(loadOptions(fixture));

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.licenseId, "lic-2026-0001");
  assert.deepEqual(result.data.device, fixture.binding);
});

test("reports a missing license clearly", async (t) => {
  const fixture = makeFixture(t);
  const missingDir = path.join(fixture.root, "absent");

  const read = await readLicenseFile(missingDir, storageOptions(fixture));
  assert.equal(read.ok, false);
  assert.equal(read.code, "LICENSE_MISSING");

  const loaded = await loadActivatedLicense(loadOptions(fixture, { storageDir: missingDir }));
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, "LICENSE_MISSING");
});

test("reports invalid JSON and invalid envelope shapes clearly", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.storageDir, { recursive: true });
  const licensePath = path.join(fixture.storageDir, LICENSE_FILE_NAME);
  const options = storageOptions(fixture);

  fs.writeFileSync(licensePath, "not json", "utf8");
  const badJson = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(badJson.ok, false);
  assert.equal(badJson.code, "LICENSE_INVALID");
  assert.equal(badJson.cause, "MALFORMED_ENVELOPE");

  fs.writeFileSync(licensePath, JSON.stringify({}), "utf8");
  const badShape = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(badShape.ok, false);
  assert.equal(badShape.code, "LICENSE_INVALID");

  assert.equal(validateLicenseEnvelope("not json").code, "LICENSE_INVALID");
  assert.equal(validateLicenseEnvelope({}).code, "LICENSE_INVALID");
});

test("reports device mismatches and unavailable identifiers clearly", async (t) => {
  const fixture = makeFixture(t);
  await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));

  const wrongDevice = await loadActivatedLicense(loadOptions(fixture, {
    deviceIdentifiers: makeValues({
      machineGuid: "87654321-4321-4321-4321-BA0987654321",
    }),
  }));
  assert.equal(wrongDevice.ok, false);
  assert.equal(wrongDevice.code, "DEVICE_MISMATCH");
  assert.equal(wrongDevice.identifier, "machineGuid");

  const missing = makeValues();
  delete missing.smbiosUuid;
  const missingIdentifier = await loadActivatedLicense(loadOptions(fixture, {
    deviceIdentifiers: missing,
  }));
  assert.equal(missingIdentifier.ok, false);
  assert.equal(missingIdentifier.code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(missingIdentifier.identifier, "smbiosUuid");
});

test("rejects a signed license with a null device binding", async (t) => {
  const fixture = makeFixture(t);
  const nullDevice = signEnvelope(makePayload(null), fixture.keys.privateKey);
  writeRawLicense(fixture, nullDevice);

  const result = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEVICE_REQUIRED");
});

test("reports invalid signatures and unknown keys as invalid licenses", async (t) => {
  const fixture = makeFixture(t);
  const tampered = Object.assign({}, fixture.envelope);
  const signature = Buffer.from(tampered.signature, "base64url");
  signature[0] ^= 0xff;
  tampered.signature = signature.toString("base64url");
  writeRawLicense(fixture, tampered);

  const invalidSignature = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(invalidSignature.ok, false);
  assert.equal(invalidSignature.code, "LICENSE_INVALID");
  assert.equal(invalidSignature.cause, "INVALID_SIGNATURE");

  const wrongRegistry = createTrustedKeyRegistry([
    { keyId: "other-key", publicKey: fixture.keys.publicKey },
  ]).data;
  const unknownKey = await loadActivatedLicense(loadOptions(fixture, {
    registry: wrongRegistry,
  }));
  assert.equal(unknownKey.ok, false);
  assert.equal(unknownKey.code, "LICENSE_INVALID");
  assert.equal(unknownKey.cause, "UNKNOWN_KEY_ID");
});

test("refuses unsafe storage paths without touching the filesystem", async (t) => {
  const fixture = makeFixture(t);
  const forbidden = path.join(fixture.root, "Documents", "CentreData");
  const options = storageOptions(fixture);

  const write = await writeLicenseFile(forbidden, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, false);
  assert.equal(write.code, "UNSAFE_LICENSE_STORAGE");

  const read = await readLicenseFile(forbidden, options);
  assert.equal(read.ok, false);
  assert.equal(read.code, "UNSAFE_LICENSE_STORAGE");

  const loaded = await loadActivatedLicense(loadOptions(fixture, {
    storageDir: forbidden,
  }));
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, "UNSAFE_LICENSE_STORAGE");
});

test("never creates the protected data directory while checking or writing a license", async (t) => {
  const fixture = makeFixture(t);

  const read = await readLicenseFile(fixture.storageDir, storageOptions(fixture));
  assert.equal(read.code, "LICENSE_MISSING");
  assert.equal(fs.existsSync(fixture.dataDir), false);

  const loaded = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(loaded.code, "LICENSE_MISSING");
  assert.equal(fs.existsSync(fixture.dataDir), false);

  const write = await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, true, write.error);
  assert.equal(fs.existsSync(fixture.dataDir), false);
  assert.equal(fs.existsSync(fixture.storageDir), true);
});

test("does not modify sibling data when writing a license", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  const sentinel = path.join(fixture.dataDir, "centre-data.json");
  fs.writeFileSync(sentinel, "user data stays untouched", "utf8");

  const write = await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, true, write.error);

  assert.equal(fs.readFileSync(sentinel, "utf8"), "user data stays untouched");
  assert.equal(fs.existsSync(path.join(fixture.storageDir, LICENSE_FILE_NAME)), true);
});

test("atomically replaces an existing license and leaves no temp files", async (t) => {
  const fixture = makeFixture(t);
  await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));

  const replacement = issueLicense({
    privateKey: fixture.keys.privateKey,
    keyId: KEY_ID,
    deviceBinding: fixture.binding,
    licenseId: "lic-2026-0002",
    licensee: "Centre de soutien",
    issuedAt: "2026-02-01",
  });
  assert.equal(replacement.ok, true, replacement.error);

  const write = await writeLicenseFile(
    fixture.storageDir,
    replacement.data,
    writeOptions(fixture)
  );
  assert.equal(write.ok, true, write.error);

  const loaded = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.data.licenseId, "lic-2026-0002");

  const leftover = fs.readdirSync(fixture.storageDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftover, []);
});

test("fails closed and preserves the old license when replacement fails", async (t) => {
  const fixture = makeFixture(t);
  await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));

  const replacement = issueLicense({
    privateKey: fixture.keys.privateKey,
    keyId: KEY_ID,
    deviceBinding: fixture.binding,
    licenseId: "lic-2026-0002",
    licensee: "Centre de soutien",
    issuedAt: "2026-02-01",
  });
  assert.equal(replacement.ok, true, replacement.error);

  const failure = await writeLicenseFile(fixture.storageDir, replacement.data, writeOptions(fixture, {
    rename: async () => {
      const error = new Error("simulated locked file");
      error.code = "EPERM";
      throw error;
    },
  }));
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "LICENSE_WRITE_FAILED");

  // The previous license must still be present and loadable.
  const loaded = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.data.licenseId, "lic-2026-0001");

  const leftover = fs.readdirSync(fixture.storageDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftover, []);
});

test("never replaces a valid stored license with an invalid, mismatched, or untrusted license", async (t) => {
  const fixture = makeFixture(t);
  const options = writeOptions(fixture);
  await writeLicenseFile(fixture.storageDir, fixture.envelope, options);

  const originalText = readLicenseText(fixture);
  const originalLoaded = await loadActivatedLicense(loadOptions(fixture));
  assert.equal(originalLoaded.ok, true, originalLoaded.error);
  assert.equal(originalLoaded.data.licenseId, "lic-2026-0001");

  const attacker = makeKeyPair();
  const otherBinding = makeBinding(makeValues({ machineGuid: OTHER_MACHINE_GUID }));

  const tampered = Object.assign({}, fixture.envelope);
  const signature = Buffer.from(tampered.signature, "base64url");
  signature[0] ^= 0xff;
  tampered.signature = signature.toString("base64url");

  const incompleteBinding = JSON.parse(JSON.stringify(fixture.binding));
  delete incompleteBinding.identifiers.smbiosUuid;

  const issue = function (overrides) {
    const result = issueLicense(Object.assign({
      privateKey: fixture.keys.privateKey,
      keyId: KEY_ID,
      deviceBinding: fixture.binding,
      licenseId: "lic-2026-bad",
      licensee: "Centre de soutien",
      issuedAt: "2026-02-01",
    }, overrides || {}));
    assert.equal(result.ok, true, result.error);
    return result.data;
  };

  const cases = [
    { name: "invalid signature", envelope: tampered, code: "INVALID_SIGNATURE" },
    {
      name: "untrusted signing key",
      envelope: issue({ privateKey: attacker.privateKey }),
      code: "INVALID_SIGNATURE",
    },
    {
      name: "unknown key id",
      envelope: issue({ keyId: "unknown-key" }),
      code: "UNKNOWN_KEY_ID",
    },
    {
      name: "device mismatch",
      envelope: issue({ deviceBinding: otherBinding }),
      code: "DEVICE_MISMATCH",
    },
    {
      name: "null device",
      envelope: signEnvelope(makePayload(null), fixture.keys.privateKey),
      code: "DEVICE_REQUIRED",
    },
    {
      name: "incomplete binding",
      envelope: signEnvelope(makePayload(incompleteBinding), fixture.keys.privateKey),
      code: "MALFORMED_DEVICE_BINDING",
    },
    {
      name: "missing trusted registry",
      envelope: fixture.envelope,
      options: writeOptions(fixture, { registry: undefined }),
      code: "INVALID_OPTIONS",
    },
    {
      name: "missing current identifiers",
      envelope: fixture.envelope,
      options: writeOptions(fixture, { deviceIdentifiers: undefined }),
      code: "INVALID_OPTIONS",
    },
    { name: "malformed envelope", envelope: {}, code: "LICENSE_INVALID" },
  ];

  for (const item of cases) {
    const result = await writeLicenseFile(
      fixture.storageDir,
      item.envelope,
      item.options || options
    );
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, item.code, item.name);

    // The old license bytes are untouched and no temporary file remains.
    assert.equal(readLicenseText(fixture), originalText, item.name);
    assert.deepEqual(tempFiles(fixture), [], item.name);

    // The old license is still loadable and is still the old license.
    const loaded = await loadActivatedLicense(loadOptions(fixture));
    assert.equal(loaded.ok, true, item.name);
    assert.equal(loaded.data.licenseId, "lic-2026-0001", item.name);
  }
});

test("verifies a new license before creating the storage directory", async (t) => {
  const fixture = makeFixture(t);
  const tampered = Object.assign({}, fixture.envelope);
  const signature = Buffer.from(tampered.signature, "base64url");
  signature[0] ^= 0xff;
  tampered.signature = signature.toString("base64url");

  const result = await writeLicenseFile(fixture.storageDir, tampered, writeOptions(fixture));

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SIGNATURE");
  assert.equal(fs.existsSync(fixture.storageDir), false);
  assert.equal(fs.existsSync(fixture.dataDir), false);
});

test("rejects oversized and malformed envelopes before writing", async (t) => {
  const fixture = makeFixture(t);

  const huge = {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: KEY_ID,
    payload: "a".repeat(MAX_LICENSE_BYTES),
    signature: "a".repeat(MAX_LICENSE_BYTES),
  };
  const tooLarge = await writeLicenseFile(fixture.storageDir, huge, writeOptions(fixture));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, "LICENSE_TOO_LARGE");
  assert.equal(fs.existsSync(path.join(fixture.storageDir, LICENSE_FILE_NAME)), false);

  const malformed = await writeLicenseFile(fixture.storageDir, {}, writeOptions(fixture));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "LICENSE_INVALID");

  // Failures before writing must not create the storage directory.
  assert.equal(fs.existsSync(fixture.storageDir), false);
});

test("rejects a symbolic-link license file", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link test is not run on Windows");
    return;
  }

  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.storageDir, { recursive: true });
  const target = path.join(fixture.root, "outside.json");
  fs.writeFileSync(target, JSON.stringify(fixture.envelope), "utf8");
  fs.symlinkSync(target, path.join(fixture.storageDir, LICENSE_FILE_NAME));

  const read = await readLicenseFile(fixture.storageDir, storageOptions(fixture));
  assert.equal(read.ok, false);
  assert.equal(read.code, "LICENSE_UNREADABLE");
});

test("rejects a storage directory that is itself a symbolic link", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link test is not run on Windows");
    return;
  }

  const fixture = makeFixture(t);
  const real = path.join(fixture.root, "real-license");
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, fixture.storageDir);

  const resolved = resolveLicenseStorage(fixture.storageDir, storageOptions(fixture));
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "UNSAFE_LICENSE_STORAGE");

  const write = await writeLicenseFile(fixture.storageDir, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, false);
  assert.equal(write.code, "UNSAFE_LICENSE_STORAGE");
  assert.equal(fs.existsSync(path.join(real, LICENSE_FILE_NAME)), false);
});

test("rejects a symlinked ancestor that resolves into the protected data directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link test is not run on Windows");
    return;
  }

  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  const sentinel = path.join(fixture.dataDir, "centre-data.json");
  fs.writeFileSync(sentinel, "user data stays untouched", "utf8");

  const alias = path.join(fixture.root, "documents-alias");
  fs.symlinkSync(fixture.dataDir, alias);

  const storageDir = path.join(alias, "license");
  const resolved = resolveLicenseStorage(storageDir, storageOptions(fixture));
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "UNSAFE_LICENSE_STORAGE");

  const write = await writeLicenseFile(storageDir, fixture.envelope, writeOptions(fixture));
  assert.equal(write.ok, false);
  assert.equal(write.code, "UNSAFE_LICENSE_STORAGE");

  assert.equal(fs.readFileSync(sentinel, "utf8"), "user data stays untouched");
  assert.equal(fs.existsSync(path.join(fixture.dataDir, "license")), false);
});
