"use strict";

/**
 * Packaging policy and static artifact-safety audit (Phase 4C).
 *
 * This test never builds or packages the application. It verifies the real
 * `package.json` allowlist and runs a read-only scanner against temporary
 * fixture directories that simulate packaged application artifacts.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const PACKAGE_JSON = path.join(PROJECT_ROOT, "package.json");
const PHASE4_DOC = path.join(PROJECT_ROOT, "PHASE4_INTEGRATION.md");

const LICENSING_RUNTIME_MODULES = Object.freeze([
  "startup-license.js",
  "license-verification.js",
  "device-fingerprint.js",
  "license-activation.js",
  "license-store.js",
  "trusted-keys.js",
]);

const EXPECTED_RUNTIME_INCLUDES = Object.freeze([
  "main.js",
  "preload.js",
  "index.html",
  "app.js",
  "data-validation.js",
  "data-store.js",
  "security.js",
  "save-queue.js",
  "shutdown-coordinator.js",
  "onedrive-warning.js",
  "runtime-paths.js",
  "startup-license.js",
  "license-verification.js",
  "device-fingerprint.js",
  "license-activation.js",
  "license-store.js",
  "trusted-keys.js",
  "fonts/**/*",
]);

const REQUIRED_EXCLUSIONS = Object.freeze([
  "!tools/**",
  "!test/**",
  "!certs/**",
  "!keys/**",
  "!signing/**",
  "!.rollback/**",
  "!coverage/**",
  "!dist/**",
  "!out/**",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/*.tmp",
  "!**/*.log",
  "!**/*.test.js",
  "!**/.env",
  "!**/id_rsa",
  "!**/id_ed25519",
  "!license.json",
  "!device-binding.json",
  "!**/license-issuer.js",
  "!**/issue-license.js",
  "!*.bat",
  "!README.txt",
  "!TEST_ISOLATION.md",
  "!PHASE4_INTEGRATION.md",
]);

const FORBIDDEN_SEGMENTS = new Set([
  "tools",
  "test",
  "certs",
  "keys",
  "signing",
  ".rollback",
  "coverage",
  "dist",
  "out",
]);

const FORBIDDEN_EXTENSIONS = Object.freeze([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".tmp",
  ".log",
]);

const FORBIDDEN_BASENAMES = new Set([
  ".env",
  "license.json",
  "device-binding.json",
  "id_rsa",
  "id_ed25519",
  "license-issuer.js",
  "issue-license.js",
  "readme.txt",
  "test_isolation.md",
  "phase4_integration.md",
]);

const PRIVATE_KEY_MARKERS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
]);

const MAX_SCAN_BYTES = 1024 * 1024;

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
}

function forbiddenPathReason(relative) {
  const segments = relative.split("/");
  const base = segments[segments.length - 1];
  const lowerBase = base.toLowerCase();

  for (const segment of segments.slice(0, -1)) {
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) return "forbidden directory";
  }
  if (FORBIDDEN_SEGMENTS.has(lowerBase)) return "forbidden directory";
  if (FORBIDDEN_BASENAMES.has(lowerBase)) return "forbidden file";
  if (lowerBase.endsWith(".bat")) return "development launcher";
  if (lowerBase.endsWith(".test.js")) return "test file";
  for (const extension of FORBIDDEN_EXTENSIONS) {
    if (lowerBase.endsWith(extension)) return "forbidden extension";
  }
  return null;
}

function auditManifest(entries) {
  return entries.filter((entry) => forbiddenPathReason(entry) !== null);
}

function scanArtifact(root) {
  const violations = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const reason = forbiddenPathReason(relative);

      if (reason) violations.push(relative + " (" + reason + ")");

      if (entry.isSymbolicLink()) {
        violations.push(relative + " (symbolic link)");
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const stats = fs.statSync(absolute);
      if (stats.size > MAX_SCAN_BYTES) {
        violations.push(relative + " (too large to scan)");
        continue;
      }

      const text = fs.readFileSync(absolute, "latin1");
      for (const marker of PRIVATE_KEY_MARKERS) {
        if (marker.test(text)) {
          violations.push(relative + " (private key marker)");
          break;
        }
      }
    }
  }

  return violations;
}

function makeTempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-packaging-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

function resolveRuntimeDependency(fromFile, request) {
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), request)
  );
  return target.endsWith(".js") ? target : target + ".js";
}

test("package.json uses the approved runtime allowlist and explicit exclusions", () => {
  const pkg = readPackage();
  assert.equal(typeof pkg.build, "object");
  assert.equal(Array.isArray(pkg.build.files), true);
  assert.equal(pkg.build.asar, true, "ASAR must be explicitly enabled");

  const entries = pkg.build.files;
  const includes = entries.filter((entry) => !entry.startsWith("!"));
  const excludes = entries.filter((entry) => entry.startsWith("!"));

  assert.deepEqual(
    includes.slice().sort(),
    EXPECTED_RUNTIME_INCLUDES.slice().sort(),
    "unexpected or missing positive package entries"
  );
  assert.deepEqual(
    excludes.slice().sort(),
    REQUIRED_EXCLUSIONS.slice().sort(),
    "unexpected or missing explicit exclusions"
  );

  assert.deepEqual(auditManifest(includes), []);
});

test("all licensing runtime modules are packaged", () => {
  const entries = readPackage().build.files;

  for (const moduleName of LICENSING_RUNTIME_MODULES) {
    assert.match(moduleName, /^[a-z0-9-]+\.js$/);
    assert.equal(entries.includes(moduleName), true, moduleName);
  }
});

test("every relative runtime dependency is present in the package allowlist", () => {
  const includes = new Set(
    EXPECTED_RUNTIME_INCLUDES.filter((entry) => entry.endsWith(".js"))
  );
  const pending = ["main.js", "preload.js"].concat(LICENSING_RUNTIME_MODULES);
  const seen = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    assert.equal(includes.has(file), true, "missing runtime module: " + file);

    const source = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      pending.push(resolveRuntimeDependency(file, match[1]));
    }
  }

  const html = fs.readFileSync(path.join(PROJECT_ROOT, "index.html"), "utf8");
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const script = path.posix.normalize(match[1]);
    assert.equal(includes.has(script), true, "missing renderer script: " + script);
  }
});

test("PHASE4_INTEGRATION.md documents the allowlist, ASAR policy, and blockers", () => {
  const doc = fs.readFileSync(PHASE4_DOC, "utf8");

  for (const moduleName of LICENSING_RUNTIME_MODULES) {
    assert.equal(doc.includes('"' + moduleName + '"'), true, moduleName);
  }
  assert.equal(doc.includes("ASAR"), true);
  assert.equal(doc.includes("tools/"), true);
  assert.equal(doc.includes("Remaining release blockers"), true);
});

test("the manifest audit rejects owner tools, tests, keys, signing material, and fixtures", () => {
  const unsafe = [
    "tools/license-issuer.js",
    "tools/issue-license.js",
    "test/license-store.test.js",
    "certs/signing.pem",
    "certs/private.key",
    "certs/signing.p12",
    "certs/signing.pfx",
    "keys/id_rsa",
    "keys/id_ed25519",
    "signing/private.p12",
    ".rollback/main.js",
    "coverage/lcov.info",
    "dist/app.js",
    "out/build.js",
    "license.json",
    "backups/device-binding.json",
    "debug.log",
    ".env",
    "temp.tmp",
    "root.test.js",
    "license-issuer.js",
    "installer.bat",
    "README.txt",
    "TEST_ISOLATION.md",
    "PHASE4_INTEGRATION.md",
  ];

  const violations = auditManifest(unsafe);
  for (const entry of unsafe) {
    assert.equal(violations.includes(entry), true, entry);
  }
});

test("the artifact scanner accepts a clean simulated package", (t) => {
  const root = makeTempDir(t);

  for (const entry of EXPECTED_RUNTIME_INCLUDES) {
    if (entry === "fonts/**/*") continue;
    writeFixture(root, entry, "module.exports = {};\n");
  }
  writeFixture(root, "fonts/Cairo-Regular.ttf", "font-bytes");
  writeFixture(root, "fonts/OFL.txt", "font license");
  writeFixture(root, "package.json", "{}");
  writeFixture(root, "node_modules/runtime-dep/index.js", "module.exports = {};\n");

  assert.deepEqual(scanArtifact(root), []);
});

test("the artifact scanner detects forbidden paths, files, extensions, and key material", (t) => {
  const root = makeTempDir(t);

  writeFixture(root, "main.js", "console.log('centre');\n");
  writeFixture(root, "resources/tools/license-issuer.js", "module.exports = {};\n");
  writeFixture(root, "test/license-store.test.js", "");
  writeFixture(root, "certs/signing.pem", "not a real key");
  writeFixture(root, "keys/id_rsa", "not a real key");
  writeFixture(root, "signing/private.p12", "not a real key");
  writeFixture(root, ".rollback/main.js", "");
  writeFixture(root, "coverage/lcov.info", "");
  writeFixture(root, "dist/app.js", "");
  writeFixture(root, "out/build.js", "");
  writeFixture(root, "license.json", "{}");
  writeFixture(root, "backups/device-binding.json", "{}");
  writeFixture(root, "debug.log", "");
  writeFixture(root, ".env", "SECRET=value");
  writeFixture(root, "temp.tmp", "");
  writeFixture(root, "bundle.pfx", "");
  writeFixture(root, "root.test.js", "");
  writeFixture(root, "license-issuer.js", "");
  writeFixture(root, "installer.bat", "");
  writeFixture(root, "README.txt", "");
  writeFixture(root, "TEST_ISOLATION.md", "");
  writeFixture(root, "PHASE4_INTEGRATION.md", "");
  writeFixture(
    root,
    "rsa.js",
    "-----BEGIN RSA PRIVATE KEY-----\nnot a real key\n-----END RSA PRIVATE KEY-----\n"
  );
  writeFixture(
    root,
    "openssh.js",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n"
  );
  writeFixture(
    root,
    "encrypted.js",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot a real key\n-----END ENCRYPTED PRIVATE KEY-----\n"
  );
  writeFixture(
    root,
    "notes.txt",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nnot a real key\n"
  );

  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "main.js"), path.join(root, "linked.js"));
  }

  const violations = scanArtifact(root);
  const expected = [
    "resources/tools/license-issuer.js (forbidden directory)",
    "test/license-store.test.js (forbidden directory)",
    "certs/signing.pem (forbidden directory)",
    "keys/id_rsa (forbidden directory)",
    "signing/private.p12 (forbidden directory)",
    ".rollback/main.js (forbidden directory)",
    "coverage/lcov.info (forbidden directory)",
    "dist/app.js (forbidden directory)",
    "out/build.js (forbidden directory)",
    "license.json (forbidden file)",
    "backups/device-binding.json (forbidden file)",
    "debug.log (forbidden extension)",
    ".env (forbidden file)",
    "temp.tmp (forbidden extension)",
    "bundle.pfx (forbidden extension)",
    "root.test.js (test file)",
    "license-issuer.js (forbidden file)",
    "installer.bat (development launcher)",
    "README.txt (forbidden file)",
    "TEST_ISOLATION.md (forbidden file)",
    "PHASE4_INTEGRATION.md (forbidden file)",
    "rsa.js (private key marker)",
    "openssh.js (private key marker)",
    "encrypted.js (private key marker)",
    "notes.txt (private key marker)",
  ];

  if (process.platform !== "win32") expected.push("linked.js (symbolic link)");

  for (const entry of expected) {
    assert.equal(violations.includes(entry), true, entry);
  }
});
