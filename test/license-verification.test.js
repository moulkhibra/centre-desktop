"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  verifyLicense,
  LICENSE_SCHEMA,
  LICENSE_ALGORITHM,
  PRODUCT_ID,
  MAX_LICENSE_BYTES,
  MAX_PAYLOAD_BYTES,
} = require("../license-verification");

const NOW = new Date("2026-06-15T12:00:00Z");

function makeKeyPair() {
  return crypto.generateKeyPairSync("ed25519");
}

function makePayload(overrides) {
  return Object.assign({
    product: PRODUCT_ID,
    licenseId: "lic-2026-0001",
    licensee: "Centre de soutien",
    issuedAt: "2026-01-01",
    notBefore: "2026-01-01",
    type: "perpetual",
    device: null,
  }, overrides || {});
}

function makeEnvelope(payload, privateKey, options) {
  const opts = options || {};
  const bytes = opts.bytes || Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, bytes, privateKey);
  return {
    schema: opts.schema === undefined ? LICENSE_SCHEMA : opts.schema,
    alg: opts.alg === undefined ? LICENSE_ALGORITHM : opts.alg,
    keyId: opts.keyId === undefined ? "test-key-1" : opts.keyId,
    payload: bytes.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

function verify(envelope, publicKey, options) {
  return verifyLicense(envelope, Object.assign({ publicKey: publicKey, now: NOW }, options || {}));
}

test("accepts a valid perpetual license and returns the signed payload", () => {
  const keys = makeKeyPair();
  const payload = makePayload();
  const result = verify(makeEnvelope(payload, keys.privateKey), keys.publicKey);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.product, PRODUCT_ID);
  assert.equal(result.data.licenseId, "lic-2026-0001");
  assert.equal(result.data.licensee, "Centre de soutien");
  assert.equal(result.data.issuedAt, "2026-01-01");
  assert.equal(result.data.notBefore, "2026-01-01");
  assert.equal(result.data.type, "perpetual");
  assert.equal(result.data.device, null);
});

test("accepts a serialized envelope and optional not-before values", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const serialized = verify(JSON.stringify(envelope), keys.publicKey);
  assert.equal(serialized.ok, true, serialized.error);

  const withoutNotBefore = makePayload();
  delete withoutNotBefore.notBefore;
  const absent = verify(makeEnvelope(withoutNotBefore, keys.privateKey), keys.publicKey);
  assert.equal(absent.ok, true, absent.error);

  const nullNotBefore = makePayload({ notBefore: null });
  const nulled = verify(makeEnvelope(nullNotBefore, keys.privateKey), keys.publicKey);
  assert.equal(nulled.ok, true, nulled.error);
});

test("enforces not-before dates using UTC calendar dates", () => {
  const keys = makeKeyPair();

  const today = verify(
    makeEnvelope(makePayload({ notBefore: "2026-06-15" }), keys.privateKey),
    keys.publicKey
  );
  assert.equal(today.ok, true, today.error);

  const future = verify(
    makeEnvelope(makePayload({ notBefore: "2026-06-16" }), keys.privateKey),
    keys.publicKey
  );
  assert.equal(future.ok, false);
  assert.equal(future.code, "NOT_YET_VALID");
});

test("rejects wrong or missing product identifiers", () => {
  const keys = makeKeyPair();

  const wrong = verify(
    makeEnvelope(makePayload({ product: "ma.centre.other" }), keys.privateKey),
    keys.publicKey
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "PRODUCT_MISMATCH");

  const missing = makePayload();
  delete missing.product;
  const absent = verify(makeEnvelope(missing, keys.privateKey), keys.publicKey);
  assert.equal(absent.ok, false);
  assert.equal(absent.code, "MALFORMED_PAYLOAD");
});

test("rejects unsupported or missing license types", () => {
  const keys = makeKeyPair();

  for (const type of ["subscription", "trial", "Perpetual"]) {
    const result = verify(
      makeEnvelope(makePayload({ type: type }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, type);
    assert.equal(result.code, "UNSUPPORTED_LICENSE_TYPE", type);
  }

  const missing = makePayload();
  delete missing.type;
  const absent = verify(makeEnvelope(missing, keys.privateKey), keys.publicKey);
  assert.equal(absent.ok, false);
  assert.equal(absent.code, "MALFORMED_PAYLOAD");
});

test("rejects invalid issue and not-before dates", () => {
  const keys = makeKeyPair();
  const invalidIssuedAt = ["2026-02-30", "2026-13-01", "2026-1-1", "20260101", 20260101, null];

  for (const issuedAt of invalidIssuedAt) {
    const result = verify(
      makeEnvelope(makePayload({ issuedAt: issuedAt }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, String(issuedAt));
    assert.equal(result.code, "INVALID_ISSUED_AT", String(issuedAt));
  }

  const invalidNotBefore = ["2026-02-30", "2026-13-01", "2026-1-1", 20260101, true];
  for (const notBefore of invalidNotBefore) {
    const result = verify(
      makeEnvelope(makePayload({ notBefore: notBefore }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, String(notBefore));
    assert.equal(result.code, "INVALID_NOT_BEFORE", String(notBefore));
  }
});

test("rejects malformed license IDs and licensee names", () => {
  const keys = makeKeyPair();

  const invalidIds = ["", "bad id", "lic-2026-0001!", "a".repeat(129)];
  for (const licenseId of invalidIds) {
    const result = verify(
      makeEnvelope(makePayload({ licenseId: licenseId }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, licenseId);
    assert.equal(result.code, "INVALID_LICENSE_ID", licenseId);
  }

  const invalidLicensees = ["", "   ", "Bad\u0000Name", "a".repeat(257)];
  for (const licensee of invalidLicensees) {
    const result = verify(
      makeEnvelope(makePayload({ licensee: licensee }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, licensee);
    assert.equal(result.code, "INVALID_LICENSEE", licensee);
  }
});

test("requires the reserved device field and accepts only null or an object", () => {
  const keys = makeKeyPair();

  const missing = makePayload();
  delete missing.device;
  const absent = verify(makeEnvelope(missing, keys.privateKey), keys.publicKey);
  assert.equal(absent.ok, false);
  assert.equal(absent.code, "MALFORMED_PAYLOAD");

  for (const device of ["device", 42, true, []]) {
    const result = verify(
      makeEnvelope(makePayload({ device: device }), keys.privateKey),
      keys.publicKey
    );
    assert.equal(result.ok, false, String(device));
    assert.equal(result.code, "MALFORMED_PAYLOAD", String(device));
  }

  const reserved = verify(
    makeEnvelope(
      makePayload({ device: { scheme: "centre-fp/1", machineGuid: "reserved" } }),
      keys.privateKey
    ),
    keys.publicKey
  );
  assert.equal(reserved.ok, true, reserved.error);
  assert.equal(reserved.data.device.scheme, "centre-fp/1");
});

test("rejects modified payloads, modified signatures, and the wrong key", () => {
  const signer = makeKeyPair();
  const other = makeKeyPair();
  const payload = makePayload();
  const envelope = makeEnvelope(payload, signer.privateKey);

  const changedPayload = makePayload({ licensee: "Another Centre" });
  const modifiedPayload = verify(
    Object.assign({}, envelope, {
      payload: Buffer.from(JSON.stringify(changedPayload), "utf8").toString("base64url"),
    }),
    signer.publicKey
  );
  assert.equal(modifiedPayload.ok, false);
  assert.equal(modifiedPayload.code, "INVALID_SIGNATURE");

  const otherEnvelope = makeEnvelope(changedPayload, other.privateKey);
  const modifiedSignature = verify(
    Object.assign({}, envelope, { signature: otherEnvelope.signature }),
    signer.publicKey
  );
  assert.equal(modifiedSignature.ok, false);
  assert.equal(modifiedSignature.code, "INVALID_SIGNATURE");

  const wrongKey = verify(envelope, other.publicKey);
  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.code, "INVALID_SIGNATURE");
});

test("verifies the exact payload bytes rather than a re-serialized object", () => {
  const keys = makeKeyPair();
  const payload = makePayload();
  const compactBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, compactBytes, keys.privateKey);
  const envelope = {
    schema: LICENSE_SCHEMA,
    alg: LICENSE_ALGORITHM,
    keyId: "test-key-1",
    payload: Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString("base64url"),
    signature: signature.toString("base64url"),
  };

  const result = verify(envelope, keys.publicKey);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SIGNATURE");
});

test("rejects malformed envelopes, algorithms, key IDs, and signatures", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const notJson = verify("not json", keys.publicKey);
  assert.equal(notJson.code, "MALFORMED_ENVELOPE");

  const array = verify([], keys.publicKey);
  assert.equal(array.code, "MALFORMED_ENVELOPE");

  const wrongSchema = verify(Object.assign({}, envelope, { schema: "centre-license/2" }), keys.publicKey);
  assert.equal(wrongSchema.code, "UNSUPPORTED_SCHEMA");

  const wrongAlgorithm = verify(Object.assign({}, envelope, { alg: "RS256" }), keys.publicKey);
  assert.equal(wrongAlgorithm.code, "UNSUPPORTED_ALGORITHM");

  const wrongKeyId = verify(Object.assign({}, envelope, { keyId: "bad key id" }), keys.publicKey);
  assert.equal(wrongKeyId.code, "MALFORMED_ENVELOPE");

  const wrongPayloadEncoding = verify(Object.assign({}, envelope, { payload: "***" }), keys.publicKey);
  assert.equal(wrongPayloadEncoding.code, "MALFORMED_ENVELOPE");

  const wrongSignatureEncoding = verify(Object.assign({}, envelope, { signature: "***" }), keys.publicKey);
  assert.equal(wrongSignatureEncoding.code, "MALFORMED_SIGNATURE");

  const shortSignature = verify(
    Object.assign({}, envelope, { signature: Buffer.alloc(63).toString("base64url") }),
    keys.publicKey
  );
  assert.equal(shortSignature.code, "MALFORMED_SIGNATURE");
});

test("checks the expected key ID when the caller provides one", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const match = verify(envelope, keys.publicKey, { expectedKeyId: "test-key-1" });
  assert.equal(match.ok, true, match.error);

  const mismatch = verify(envelope, keys.publicKey, { expectedKeyId: "other-key" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "KEY_ID_MISMATCH");
});

test("rejects oversized input and oversized decoded payloads", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const tooLarge = verify("x".repeat(MAX_LICENSE_BYTES + 1), keys.publicKey);
  assert.equal(tooLarge.code, "TOO_LARGE");

  const hugeBytes = Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61);
  const hugeEnvelope = makeEnvelope(makePayload(), keys.privateKey, { bytes: hugeBytes });
  const huge = verify(hugeEnvelope, keys.publicKey);
  assert.equal(huge.code, "PAYLOAD_TOO_LARGE");
});

test("rejects invalid UTF-8, invalid JSON, and non-object payloads after signature verification", () => {
  const keys = makeKeyPair();
  const cases = [
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from("{not json", "utf8"),
    Buffer.from("[]", "utf8"),
    Buffer.from("null", "utf8"),
  ];

  for (const bytes of cases) {
    const envelope = makeEnvelope(makePayload(), keys.privateKey, { bytes: bytes });
    const result = verify(envelope, keys.publicKey);
    assert.equal(result.ok, false, bytes.toString("hex"));
    assert.equal(result.code, "MALFORMED_PAYLOAD", bytes.toString("hex"));
  }
});

test("accepts PEM and DER public keys but rejects private keys", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const pem = keys.publicKey.export({ type: "spki", format: "pem" });
  const fromPem = verifyLicense(envelope, { publicKey: pem, now: NOW });
  assert.equal(fromPem.ok, true, fromPem.error);

  const der = keys.publicKey.export({ type: "spki", format: "der" });
  const fromDer = verifyLicense(envelope, { publicKey: der, now: NOW });
  assert.equal(fromDer.ok, true, fromDer.error);

  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const fromPrivate = verifyLicense(envelope, { publicKey: privatePem, now: NOW });
  assert.equal(fromPrivate.ok, false);
  assert.equal(fromPrivate.code, "INVALID_PUBLIC_KEY");
});

test("rejects invalid public keys and invalid options", () => {
  const keys = makeKeyPair();
  const envelope = makeEnvelope(makePayload(), keys.privateKey);

  const invalidKey = verifyLicense(envelope, { publicKey: "not a key", now: NOW });
  assert.equal(invalidKey.code, "INVALID_PUBLIC_KEY");

  const ecKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const nonEd25519 = verifyLicense(envelope, { publicKey: ecKeys.publicKey, now: NOW });
  assert.equal(nonEd25519.code, "INVALID_PUBLIC_KEY");

  const privateKey = verifyLicense(envelope, { publicKey: keys.privateKey, now: NOW });
  assert.equal(privateKey.code, "INVALID_PUBLIC_KEY");

  const invalidNow = verifyLicense(envelope, { publicKey: keys.publicKey, now: "not a date" });
  assert.equal(invalidNow.code, "INVALID_OPTIONS");

  const nullNow = verifyLicense(envelope, { publicKey: keys.publicKey, now: null });
  assert.equal(nullNow.code, "INVALID_OPTIONS");

  const invalidExpectedKey = verifyLicense(envelope, {
    publicKey: keys.publicKey,
    now: NOW,
    expectedKeyId: "",
  });
  assert.equal(invalidExpectedKey.code, "INVALID_OPTIONS");
});

test("allows signed future metadata while still validating the required fields", () => {
  const keys = makeKeyPair();
  const payload = makePayload({
    features: ["core", "reports"],
    appVersion: { min: "1.0.0", max: null },
  });
  const result = verify(makeEnvelope(payload, keys.privateKey), keys.publicKey);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.data.features, ["core", "reports"]);
  assert.equal(result.data.appVersion.min, "1.0.0");
});
