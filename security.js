const path = require("path");
const { fileURLToPath } = require("url");

const ALLOWED_EXTERNAL_HOSTS = new Set(["wa.me"]);

function parseUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    return new URL(value);
  } catch (error) {
    return null;
  }
}

function isAllowedExternalUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  if (!ALLOWED_EXTERNAL_HOSTS.has(url.hostname)) return false;
  return /^\/[0-9]+$/.test(url.pathname);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isAppFileUrl(value, appIndexPath) {
  const url = parseUrl(value);
  if (!url || url.protocol !== "file:") return false;
  url.search = "";
  url.hash = "";
  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch (error) {
    return false;
  }
  return samePath(filePath, appIndexPath);
}

function isTrustedIpcEvent(event, window, appIndexPath) {
  if (!event || !window || window.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) return false;
  return isAppFileUrl(frame.url, appIndexPath);
}

function isOneDrivePath(value) {
  return typeof value === "string" && /onedrive/i.test(value);
}

module.exports = {
  isAllowedExternalUrl: isAllowedExternalUrl,
  isAppFileUrl: isAppFileUrl,
  isTrustedIpcEvent: isTrustedIpcEvent,
  isOneDrivePath: isOneDrivePath,
};
