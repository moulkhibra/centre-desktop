const fs = require("fs");
const path = require("path");

function readEnv(env, name) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, name)) return null;
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(name + " must not be empty.");
  }
  return value.trim();
}

function resolveAbsolute(value, name) {
  if (!path.isAbsolute(value) || value.indexOf("\0") !== -1) {
    throw new Error(name + " must be an absolute path.");
  }
  return path.resolve(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isStrictlyInside(child, parent) {
  let childPath = path.resolve(child);
  let parentPath = path.resolve(parent);
  if (process.platform === "win32") {
    childPath = childPath.toLowerCase();
    parentPath = parentPath.toLowerCase();
  }
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || relative === ".." || path.isAbsolute(relative)) return false;
  return !relative.startsWith(".." + path.sep);
}

function overlaps(left, right) {
  return samePath(left, right) || isStrictlyInside(left, right) || isStrictlyInside(right, left);
}

function rejectOverlap(candidate, protectedPath, message) {
  if (overlaps(candidate, protectedPath)) throw new Error(message);
}

function canonicalize(target, fsImpl, name) {
  let current = path.resolve(target);
  const suffix = [];

  while (true) {
    let real = null;
    try {
      real = fsImpl.realpathSync.native
        ? fsImpl.realpathSync.native(current)
        : fsImpl.realpathSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw new Error("Cannot safely inspect " + name + ": " + String(error && (error.code || error.message)));
      }
    }

    if (real !== null) return path.join(real, ...suffix);

    let inspected = null;
    try {
      inspected = fsImpl.lstatSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw new Error("Cannot safely inspect " + name + ": " + String(error && (error.code || error.message)));
      }
    }

    if (inspected) {
      throw new Error("Cannot safely inspect " + name + ": unresolved existing path component.");
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Cannot safely inspect " + name + ": no existing ancestor.");
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function resolveTestIsolation(options) {
  const opts = options || {};
  if (typeof opts.productionDataDir !== "string" || opts.productionDataDir.trim() === "") {
    throw new Error("The production data directory is required.");
  }
  if (typeof opts.productionUserDataDir !== "string" || opts.productionUserDataDir.trim() === "") {
    throw new Error("The production userData directory is required.");
  }

  const productionDataDir = opts.productionDataDir;
  const productionUserDataDir = opts.productionUserDataDir;
  if (opts.isPackaged) {
    return { dataDir: productionDataDir, profileDir: null };
  }

  const dataRaw = readEnv(opts.env, "CENTRE_TEST_DATA_DIR");
  const profileRaw = readEnv(opts.env, "CENTRE_TEST_PROFILE");
  if (dataRaw === null && profileRaw === null) {
    return { dataDir: productionDataDir, profileDir: null };
  }

  const dataPath = dataRaw === null
    ? null
    : resolveAbsolute(dataRaw, "CENTRE_TEST_DATA_DIR");
  const profilePath = profileRaw === null
    ? null
    : resolveAbsolute(profileRaw, "CENTRE_TEST_PROFILE");

  if (dataPath) {
    rejectOverlap(
      dataPath,
      productionDataDir,
      "CENTRE_TEST_DATA_DIR must not overlap the production data directory."
    );
    rejectOverlap(
      dataPath,
      productionUserDataDir,
      "CENTRE_TEST_DATA_DIR must not overlap the production userData directory."
    );
  }
  if (profilePath) {
    rejectOverlap(
      profilePath,
      productionDataDir,
      "CENTRE_TEST_PROFILE must not overlap the production data directory."
    );
    rejectOverlap(
      profilePath,
      productionUserDataDir,
      "CENTRE_TEST_PROFILE must not overlap the production userData directory."
    );
  }
  if (dataPath && profilePath) {
    rejectOverlap(
      dataPath,
      profilePath,
      "CENTRE_TEST_DATA_DIR must not overlap CENTRE_TEST_PROFILE."
    );
  }

  const fsImpl = opts.fs || fs;
  const canonicalProductionDataDir = canonicalize(
    productionDataDir,
    fsImpl,
    "the production data directory"
  );
  const canonicalProductionUserDataDir = canonicalize(
    productionUserDataDir,
    fsImpl,
    "the production userData directory"
  );
  const canonicalDataDir = dataPath
    ? canonicalize(dataPath, fsImpl, "CENTRE_TEST_DATA_DIR")
    : null;
  const canonicalProfileDir = profilePath
    ? canonicalize(profilePath, fsImpl, "CENTRE_TEST_PROFILE")
    : null;

  if (canonicalDataDir) {
    rejectOverlap(
      canonicalDataDir,
      canonicalProductionDataDir,
      "CENTRE_TEST_DATA_DIR resolves into the production data directory."
    );
    rejectOverlap(
      canonicalDataDir,
      canonicalProductionUserDataDir,
      "CENTRE_TEST_DATA_DIR resolves into the production userData directory."
    );
  }
  if (canonicalProfileDir) {
    rejectOverlap(
      canonicalProfileDir,
      canonicalProductionDataDir,
      "CENTRE_TEST_PROFILE resolves into the production data directory."
    );
    rejectOverlap(
      canonicalProfileDir,
      canonicalProductionUserDataDir,
      "CENTRE_TEST_PROFILE resolves into the production userData directory."
    );
  }
  if (canonicalDataDir && canonicalProfileDir) {
    rejectOverlap(
      canonicalDataDir,
      canonicalProfileDir,
      "CENTRE_TEST_DATA_DIR resolves into CENTRE_TEST_PROFILE."
    );
  }

  return {
    dataDir: canonicalDataDir || productionDataDir,
    profileDir: canonicalProfileDir,
  };
}

module.exports = {
  resolveTestIsolation: resolveTestIsolation,
};
