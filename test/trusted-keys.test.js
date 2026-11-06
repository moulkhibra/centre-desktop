"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  PRODUCTION_PUBLIC_KEYS,
  createProductionTrustedKeyRegistry,
} = require("../trusted-keys");
const {
  createTrustedKeyRegistry,
  verifyActivatedLicense,
} = require("../license-activation");
const {
  createDeviceBinding,
} = require("../device-fingerprint");
const {
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
} = require("../license-verification");

const KEY_ID = "centre-test-1";
const MACHINE_GUID = "12345678-1234-1234-1234-1234567890AB";
const SMBIOS_UUID = "ABCDEF01-2345-6789-ABCD-EF0123456789";

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "trusted-keys.js"), "utf8");

function makeValues() {
  return {
    machineGuid: MACHINE_GUID,
    smbiosUuid: SMBIOS_UUID,
  };
}

function makeBinding() {
  const result = createDeviceBinding(makeValues());
  assert.equal(result.ok, true, result.error);
  return result.data;
}

function signEnvelope(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: KEY_ID,
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, privateKey).toString("base64url"),
  };
}

function makePayload() {
  return {
    product: PRODUCT_ID,
    licenseId: "lic-2026-trust-1",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
    type: "perpetual",
    device: makeBinding(),
  };
}

test("fails closed while no production public key is configured", () => {
  assert.equal(Array.isArray(PRODUCTION_PUBLIC_KEYS), true);
  assert.equal(Object.isFrozen(PRODUCTION_PUBLIC_KEYS), true);
  assert.equal(PRODUCTION_PUBLIC_KEYS.length, 0);

  const result = createProductionTrustedKeyRegistry();
  assert.equal(result.ok, false);
  assert.equal(result.code, "PRODUCTION_KEY_NOT_CONFIGURED");
  assert.equal(Object.hasOwn(result, "data"), false);
});

test("exports only the production key placeholder and its registry factory", () => {
  const exported = Object.keys(require("../trusted-keys")).sort();
  assert.deepEqual(exported, ["PRODUCTION_PUBLIC_KEYS", "createProductionTrustedKeyRegistry"]);
});

test("never loads trusted keys from the filesystem, environment, network, or user data", () => {
  const forbidden = [
    /require\s*\(\s*["']node:fs["']\s*\)/,
    /require\s*\(\s*["']fs["']\s*\)/,
    /require\s*\(\s*["']node:https?["']\s*\)/,
    /require\s*\(\s*["']https?["']\s*\)/,
    /require\s*\(\s*["']node:net["']\s*\)/,
    /require\s*\(\s*["']node:dgram["']\s*\)/,
    /require\s*\(\s*["']node:child_process["']\s*\)/,
    /require\s*\(\s*["']child_process["']\s*\)/,
    /process\s*\.\s*env/,
    /\bprocess\s*\[\s*["']env["']\s*\]/,
    /\bfetch\s*\(/,
    /\bhttps?\s*\.\s*(?:get|request)\s*\(/,
    /\b(?:readFile|readFileSync|createReadStream|readdir|readdirSync)\s*\(/,
    /homedir\s*\(/,
    /getPath\s*\(/,
    /license\.json/,
    /device-binding\.json/,
  ];

  for (const pattern of forbidden) {
    assert.equal(pattern.test(SOURCE), false, pattern.toString());
  }

  // The only runtime import is the activation module (which owns the branded
  // registry). There is no filesystem or network dependency.
  const requires = Array.from(SOURCE.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g))
    .map((match) => match[1]);
  assert.deepEqual(requires, ["./license-activation"]);
});

test("contains no private key or signing material", () => {
  assert.equal(/PRIVATE KEY/.test(SOURCE), false);
  assert.equal(/-----BEGIN [A-Z ]*PRIVATE/.test(SOURCE), false);
  assert.equal(/generateKeyPair/.test(SOURCE), false);
  assert.equal(/createPrivateKey/.test(SOURCE), false);
  assert.equal(/crypto\s*\.\s*sign\s*\(/.test(SOURCE), false);
});

test("rejects an attacker-signed license even when the attacker key is offered", () => {
  const owner = crypto.generateKeyPairSync("ed25519");
  const attacker = crypto.generateKeyPairSync("ed25519");

  const registry = createTrustedKeyRegistry([
    { keyId: KEY_ID, publicKey: owner.publicKey },
  ]);
  assert.equal(registry.ok, true, registry.error);

  const forged = signEnvelope(makePayload(), attacker.privateKey);
  const result = verifyActivatedLicense(forged, {
    registry: registry.data,
    now: new Date("2026-06-15T12:00:00Z"),
    deviceIdentifiers: makeValues(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SIGNATURE");
});

test("rejects an unbranded registry that claims to trust the attacker key", () => {
  const attacker = crypto.generateKeyPairSync("ed25519");
  const forged = signEnvelope(makePayload(), attacker.privateKey);
  const unbranded = {
    has: () => true,
    get: () => attacker.publicKey,
    keyIds: () => [KEY_ID],
    size: 1,
  };

  const result = verifyActivatedLicense(forged, {
    registry: unbranded,
    now: new Date("2026-06-15T12:00:00Z"),
    deviceIdentifiers: makeValues(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_OPTIONS");
});

test("rejects an entry that inherits keyId or publicKey from a prototype", () => {
  const owner = crypto.generateKeyPairSync("ed25519");
  const inherited = Object.create({
    keyId: KEY_ID,
    publicKey: owner.publicKey,
  });

  const result = createTrustedKeyRegistry([inherited]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_KEY_REGISTRY");
});
