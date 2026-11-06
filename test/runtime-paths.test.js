const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveTestIsolation } = require("../runtime-paths");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "centre-stage6b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const productionDataDir = path.join(root, "production", "Documents", "CentreData");
  const productionUserDataDir = path.join(root, "production", "AppData", "Centre");
  fs.mkdirSync(productionDataDir, { recursive: true });
  fs.mkdirSync(productionUserDataDir, { recursive: true });

  return {
    root: root,
    realRoot: fs.realpathSync.native(root),
    productionDataDir: productionDataDir,
    productionUserDataDir: productionUserDataDir,
    dataDir: path.join(root, "isolated", "data"),
    profileDir: path.join(root, "isolated", "profile"),
    parentDir: path.join(root, "isolated"),
  };
}

function resolvePaths(fixture, env, isPackaged) {
  return resolveTestIsolation({
    isPackaged: Boolean(isPackaged),
    env: env,
    productionDataDir: fixture.productionDataDir,
    productionUserDataDir: fixture.productionUserDataDir,
  });
}

function trySymlinkDirectory(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (
      error &&
      (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP" || error.code === "ENOENT")
    ) {
      t.skip("Directory symlinks/junctions are unavailable: " + error.code);
      return false;
    }
    throw error;
  }
}

test("uses production defaults when no test variables are set", (t) => {
  const fixture = createFixture(t);
  const result = resolvePaths(fixture, {});
  assert.equal(result.dataDir, fixture.productionDataDir);
  assert.equal(result.profileDir, null);
});

test("accepts fresh, separate temporary data and profile directories", (t) => {
  const fixture = createFixture(t);
  const result = resolvePaths(fixture, {
    CENTRE_TEST_DATA_DIR: fixture.dataDir,
    CENTRE_TEST_PROFILE: fixture.profileDir,
  });

  assert.equal(result.dataDir, path.join(fixture.realRoot, "isolated", "data"));
  assert.equal(result.profileDir, path.join(fixture.realRoot, "isolated", "profile"));
  assert.equal(fs.existsSync(fixture.dataDir), false);
  assert.equal(fs.existsSync(fixture.profileDir), false);
});

test("ignores both variables in packaged mode", (t) => {
  const fixture = createFixture(t);
  const result = resolvePaths(
    fixture,
    {
      CENTRE_TEST_DATA_DIR: fixture.productionDataDir,
      CENTRE_TEST_PROFILE: "relative-profile",
    },
    true
  );

  assert.equal(result.dataDir, fixture.productionDataDir);
  assert.equal(result.profileDir, null);
});

test("rejects relative, empty, and null-byte paths", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: "relative-data" }),
    /must be an absolute path/
  );
  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_PROFILE: "relative-profile" }),
    /must be an absolute path/
  );
  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: "" }),
    /must not be empty/
  );
  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_PROFILE: "   " }),
    /must not be empty/
  );
  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: fixture.dataDir + "\0" }),
    /must be an absolute path/
  );
});

test("rejects test data overlapping the production userData directory", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: fixture.productionUserDataDir }),
    /production userData directory/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: path.join(fixture.productionUserDataDir, "nested"),
      }),
    /production userData directory/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: path.dirname(fixture.productionUserDataDir),
      }),
    /production userData directory/
  );
});

test("rejects the test profile overlapping the production data directory", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_PROFILE: fixture.productionDataDir }),
    /production data directory/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_PROFILE: path.join(fixture.productionDataDir, "nested"),
      }),
    /production data directory/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_PROFILE: path.dirname(fixture.productionDataDir),
      }),
    /production data directory/
  );
});

test("rejects equality and containment between test data and test profile", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: fixture.dataDir,
        CENTRE_TEST_PROFILE: fixture.dataDir,
      }),
    /overlap CENTRE_TEST_PROFILE/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: fixture.parentDir,
        CENTRE_TEST_PROFILE: fixture.profileDir,
      }),
    /overlap CENTRE_TEST_PROFILE/
  );
  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: fixture.dataDir,
        CENTRE_TEST_PROFILE: fixture.parentDir,
      }),
    /overlap CENTRE_TEST_PROFILE/
  );
});

test("rejects an existing symlink pointing to the production data root", (t) => {
  const fixture = createFixture(t);
  const link = path.join(fixture.root, "link-to-production-data");
  if (!trySymlinkDirectory(t, fixture.productionDataDir, link)) return;

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: link }),
    /resolves into the production data directory/
  );
});

test("rejects an existing symlink pointing to the production profile root", (t) => {
  const fixture = createFixture(t);
  const link = path.join(fixture.root, "link-to-production-profile");
  if (!trySymlinkDirectory(t, fixture.productionUserDataDir, link)) return;

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_PROFILE: link }),
    /resolves into the production userData directory/
  );
});

test("rejects a non-existing child beneath a symlinked production parent", (t) => {
  const fixture = createFixture(t);
  const link = path.join(fixture.root, "link-to-production-data");
  if (!trySymlinkDirectory(t, fixture.productionDataDir, link)) return;

  const child = path.join(link, "not-created-yet");
  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: child }),
    /resolves into the production data directory/
  );
  assert.equal(fs.existsSync(child), false);
});

test("rejects a dangling symlink whose target would enter production", (t) => {
  const fixture = createFixture(t);
  const link = path.join(fixture.root, "link-to-missing-production-child");
  if (!trySymlinkDirectory(t, path.join(fixture.productionDataDir, "missing"), link)) return;

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: link }),
    /unresolved existing path component/
  );
});

test("accepts a symlink to a valid isolated data directory and returns its real path", (t) => {
  const fixture = createFixture(t);
  const realDataDir = path.join(fixture.root, "real-isolated-data");
  fs.mkdirSync(realDataDir);
  const link = path.join(fixture.root, "link-to-valid-data");
  if (!trySymlinkDirectory(t, realDataDir, link)) return;

  const result = resolvePaths(fixture, {
    CENTRE_TEST_DATA_DIR: link,
    CENTRE_TEST_PROFILE: fixture.profileDir,
  });
  assert.equal(result.dataDir, fs.realpathSync.native(realDataDir));
});

test("invalid paths are rejected without creating their target directories", (t) => {
  const fixture = createFixture(t);
  const candidate = path.join(fixture.productionDataDir, "not-created");

  assert.throws(
    () => resolvePaths(fixture, { CENTRE_TEST_DATA_DIR: candidate }),
    /production data directory/
  );
  assert.equal(fs.existsSync(candidate), false);
});

test("rejects profiles overlapping the production profile after symlink resolution", (t) => {
  const fixture = createFixture(t);
  const link = path.join(fixture.root, "link-to-production-profile");
  if (!trySymlinkDirectory(t, fixture.productionUserDataDir, link)) return;

  assert.throws(
    () =>
      resolvePaths(fixture, {
        CENTRE_TEST_DATA_DIR: fixture.dataDir,
        CENTRE_TEST_PROFILE: path.join(link, "nested"),
      }),
    /resolves into the production userData directory/
  );
});
