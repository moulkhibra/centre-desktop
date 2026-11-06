"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createDeviceBinding } = require("../device-fingerprint");
const {
  createTrustedKeyRegistry,
  verifyActivatedLicense,
} = require("../license-activation");

const CLI_PATH = path.join(__dirname, "..", "tools", "issue-license.js");
const NOW = new Date("2026-06-15T12:00:00Z");
const KEY_ID = "test-key-1";
const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-issue-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeValues() {
  return {
    machineGuid: MACHINE_GUID,
    smbiosUuid: SMBIOS_UUID,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH].concat(args), {
    encoding: "utf8",
  });
}

test("issues a signed license from a private key and device-binding file", (t) => {
  const root = makeTempRoot(t);
  const keys = crypto.generateKeyPairSync("ed25519");
  const values = makeValues();
  const binding = createDeviceBinding(values);
  assert.equal(binding.ok, true, binding.error);

  const keyPath = path.join(root, "test-key.pem");
  const devicePath = path.join(root, "device-binding.json");
  const outPath = path.join(root, "license.json");
  fs.writeFileSync(
    keyPath,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    "utf8"
  );
  fs.writeFileSync(devicePath, JSON.stringify(binding.data, null, 2), "utf8");

  const result = runCli([
    "--private-key", keyPath,
    "--key-id", KEY_ID,
    "--device", devicePath,
    "--license-id", "lic-2026-0001",
    "--licensee", "Centre de soutien",
    "--issued-at", "2026-01-01",
    "--not-before", "2026-01-01",
    "--out", outPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(outPath), true);
  assert.equal(result.stdout.includes("PRIVATE KEY"), false);
  assert.equal(result.stdout.includes(MACHINE_GUID), false);

  const envelope = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const registry = createTrustedKeyRegistry([
    { keyId: KEY_ID, publicKey: keys.publicKey },
  ]).data;
  const activated = verifyActivatedLicense(envelope, {
    registry: registry,
    now: NOW,
    deviceIdentifiers: values,
  });
  assert.equal(activated.ok, true, activated.error);
  assert.equal(activated.data.licenseId, "lic-2026-0001");
  assert.deepEqual(activated.data.device, binding.data);
});

test("prints usage for --help", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("fails clearly when required options are missing", (t) => {
  const root = makeTempRoot(t);
  const result = runCli(["--out", path.join(root, "license.json")]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required option/);
  assert.equal(fs.existsSync(path.join(root, "license.json")), false);
});

test("does not write an output file when issuance fails", (t) => {
  const root = makeTempRoot(t);
  const keys = crypto.generateKeyPairSync("ed25519");
  const keyPath = path.join(root, "test-key.pem");
  const devicePath = path.join(root, "device-binding.json");
  const outPath = path.join(root, "license.json");

  fs.writeFileSync(
    keyPath,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    "utf8"
  );
  fs.writeFileSync(
    devicePath,
    JSON.stringify({ scheme: "other", match: "all", identifiers: {} }),
    "utf8"
  );

  const result = runCli([
    "--private-key", keyPath,
    "--key-id", KEY_ID,
    "--device", devicePath,
    "--license-id", "lic-2026-0001",
    "--licensee", "Centre de soutien",
    "--out", outPath,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_DEVICE_BINDING/);
  assert.equal(result.stderr.includes(MACHINE_GUID), false);
  assert.equal(fs.existsSync(outPath), false);
});
