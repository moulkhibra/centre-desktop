const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  isAllowedExternalUrl,
  isAppFileUrl,
  isTrustedIpcEvent,
  isOneDrivePath,
} = require("../security");

test("only allows the WhatsApp link shape the app generates", () => {
  assert.equal(
    isAllowedExternalUrl("https://wa.me/212612345678?text=" + encodeURIComponent("السلام عليكم")),
    true
  );
  assert.equal(isAllowedExternalUrl("https://wa.me/0612345678"), true);
  assert.equal(isAllowedExternalUrl("http://wa.me/212612345678"), false);
  assert.equal(isAllowedExternalUrl("https://wa.me.evil.test/212612345678"), false);
  assert.equal(isAllowedExternalUrl("https://evil.test/212612345678"), false);
  assert.equal(isAllowedExternalUrl("https://user:pass@wa.me/212612345678"), false);
  assert.equal(isAllowedExternalUrl("https://wa.me:8443/212612345678"), false);
  assert.equal(isAllowedExternalUrl("https://wa.me/abc"), false);
  assert.equal(isAllowedExternalUrl("https://wa.me/212/345"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("data:text/html,<script>alert(1)</script>"), false);
});

test("only accepts the exact app entry page as a local navigation target", () => {
  const index = path.join(path.sep, "app", "index.html");
  const indexUrl = pathToFileURL(index).href;
  assert.equal(isAppFileUrl(indexUrl, index), true);
  assert.equal(isAppFileUrl(indexUrl + "?x=1#hash", index), true);
  assert.equal(isAppFileUrl(pathToFileURL(path.join(path.sep, "app", "other.html")).href, index), false);
  assert.equal(isAppFileUrl("file:///etc/passwd", index), false);
  assert.equal(isAppFileUrl("https://example.com/index.html", index), false);
});

test("trusts IPC only from the main frame of the exact app page", () => {
  const index = path.join(path.sep, "app", "index.html");
  const mainFrame = { url: pathToFileURL(index).href };
  const webContents = { mainFrame };
  const window = {
    isDestroyed: () => false,
    webContents,
  };

  assert.equal(
    isTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, window, index),
    true
  );
  assert.equal(
    isTrustedIpcEvent({ sender: {}, senderFrame: mainFrame }, window, index),
    false
  );
  assert.equal(
    isTrustedIpcEvent({ sender: webContents, senderFrame: { url: mainFrame.url } }, window, index),
    false
  );
  assert.equal(
    isTrustedIpcEvent({ sender: webContents, senderFrame: { url: "https://example.com/" } }, window, index),
    false
  );
  assert.equal(
    isTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, { ...window, isDestroyed: () => true }, index),
    false
  );
});

test("detects OneDrive documents paths case-insensitively", () => {
  assert.equal(isOneDrivePath("C:\\Users\\A\\OneDrive\\Documents\\CentreData"), true);
  assert.equal(isOneDrivePath("/home/a/onedrive/Documents/CentreData"), true);
  assert.equal(isOneDrivePath("C:\\Users\\A\\Documents\\CentreData"), false);
  assert.equal(isOneDrivePath(""), false);
  assert.equal(isOneDrivePath(null), false);
  assert.equal(isOneDrivePath(undefined), false);
});
