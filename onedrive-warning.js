const fs = require("fs");
const path = require("path");

const FLAG_NAME = "onedrive-warning-shown";

function flagPath(userDataDir) {
  return path.join(userDataDir, FLAG_NAME);
}

function shouldShowOneDriveWarning(userDataDir, fileSystem) {
  const fsv = fileSystem || fs;
  if (typeof userDataDir !== "string" || userDataDir.length === 0) return true;
  try {
    return !fsv.existsSync(flagPath(userDataDir));
  } catch (error) {
    return true;
  }
}

function markOneDriveWarningShown(userDataDir, fileSystem) {
  const fsv = fileSystem || fs;
  if (typeof userDataDir !== "string" || userDataDir.length === 0) return false;
  try {
    fsv.mkdirSync(userDataDir, { recursive: true });
    fsv.writeFileSync(flagPath(userDataDir), "1\n", "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  FLAG_NAME: FLAG_NAME,
  flagPath: flagPath,
  shouldShowOneDriveWarning: shouldShowOneDriveWarning,
  markOneDriveWarningShown: markOneDriveWarningShown,
};
