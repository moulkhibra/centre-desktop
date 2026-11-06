const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FLAG_NAME,
  flagPath,
  shouldShowOneDriveWarning,
  markOneDriveWarningShown,
} = require("../onedrive-warning");

test("shows the OneDrive warning until the userData flag is written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-onedrive-flag-"));
  try {
    assert.equal(shouldShowOneDriveWarning(dir), true);
    assert.equal(fs.existsSync(path.join(dir, FLAG_NAME)), false);

    assert.equal(markOneDriveWarningShown(dir), true);
    assert.equal(fs.existsSync(flagPath(dir)), true);
    assert.equal(shouldShowOneDriveWarning(dir), false);

    assert.equal(markOneDriveWarningShown(dir), true);
    assert.equal(shouldShowOneDriveWarning(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or unreadable userData directory does not hide the warning", () => {
  assert.equal(shouldShowOneDriveWarning(""), true);
  assert.equal(shouldShowOneDriveWarning(null), true);

  const fakeFs = {
    existsSync() { throw new Error("denied"); },
  };
  assert.equal(shouldShowOneDriveWarning("/somewhere", fakeFs), true);
});
