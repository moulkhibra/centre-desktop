const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const validation = require("./data-validation");

const BACKUP_RE = /^data-.+\.json$/;

function createStore(options) {
  const dir = options.dir;
  const now = options.now || (function () { return new Date(); });
  const fsv = options.fs || fs;
  const maxBytes = typeof options.maxBytes === "number" ? options.maxBytes : validation.MAX_JSON_BYTES;
  const file = path.join(dir, "data.json");
  const backupDir = path.join(dir, "backups");
  let locked = false;
  let loadError = "";
  let knownHashes = null;

  function paths() {
    return { dir: dir, file: file, backupDir: backupDir };
  }

  function ensureDir() {
    fsv.mkdirSync(dir, { recursive: true });
    fsv.mkdirSync(backupDir, { recursive: true });
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function readText(target) {
    return stripBom(fsv.readFileSync(target, "utf8"));
  }

  function hash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  function collectHashes() {
    const result = new Map();
    let names = [];
    try {
      names = fsv.readdirSync(backupDir);
    } catch (error) {
      return result;
    }
    for (const name of names) {
      if (!BACKUP_RE.test(name)) continue;
      const target = path.join(backupDir, name);
      try {
        if (fsv.statSync(target).size > maxBytes) {
          result.set("oversized:" + name, name);
          continue;
        }
        result.set(hash(fsv.readFileSync(target)), name);
      } catch (error) {
        result.set("unreadable:" + name, name);
      }
    }
    return result;
  }

  function createBackup(rawBuffer) {
    try {
      ensureDir();
    } catch (error) {
      return { ok: false, code: "BACKUP_DIR_FAILED", error: "تعذر الوصول إلى مجلد النسخ الاحتياطية." };
    }
    const digest = hash(rawBuffer);
    if (knownHashes === null) knownHashes = collectHashes();
    const existing = knownHashes.get(digest);
    if (existing && fsv.existsSync(path.join(backupDir, existing))) {
      return { ok: true, name: null, skipped: true };
    }
    if (existing) knownHashes.delete(digest);

    const base = "data-" + validation.localTimestamp(now());
    let counter = 0;
    let name = base + ".json";
    while (true) {
      const target = path.join(backupDir, name);
      let fd = null;
      let opened = false;
      try {
        fd = fsv.openSync(target, "wx");
        opened = true;
        fsv.writeFileSync(fd, rawBuffer);
        fsv.fsyncSync(fd);
        fsv.closeSync(fd);
        fd = null;
        knownHashes.set(digest, name);
        return { ok: true, name: name, skipped: false };
      } catch (error) {
        if (fd !== null) {
          try { fsv.closeSync(fd); } catch (closeError) { void closeError; }
        }
        if (error && error.code === "EEXIST") {
          counter += 1;
          name = base + "-" + counter + ".json";
          continue;
        }
        if (opened) {
          try { fsv.unlinkSync(target); } catch (unlinkError) { void unlinkError; }
        }
        return { ok: false, code: "BACKUP_WRITE_FAILED", error: "تعذر إنشاء نسخة احتياطية قبل الحفظ." };
      }
    }
  }

  function quarantineCurrent() {
    try {
      fsv.statSync(file);
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, exists: false, name: null };
      return {
        ok: false,
        code: "RECOVERY_BACKUP_FAILED",
        error: "تعذر الوصول إلى الملف الحالي قبل الاسترجاع. لم يتم تعديل الملف.",
      };
    }

    try {
      ensureDir();
    } catch (error) {
      return { ok: false, code: "BACKUP_DIR_FAILED", error: "تعذر الوصول إلى مجلد النسخ الاحتياطية." };
    }

    const base = "data-damaged-" + validation.localTimestamp(now());
    let counter = 0;
    while (true) {
      const name = base + (counter === 0 ? "" : "-" + counter) + ".json";
      const target = path.join(backupDir, name);
      try {
        fsv.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
        return { ok: true, exists: true, name: name };
      } catch (error) {
        if (error && error.code === "EEXIST") {
          counter += 1;
          continue;
        }
        try { fsv.unlinkSync(target); } catch (unlinkError) { void unlinkError; }
        return {
          ok: false,
          code: "RECOVERY_BACKUP_FAILED",
          error: "تعذر الاحتفاظ بنسخة من الملف الحالي. لم يتم تعديل الملف.",
        };
      }
    }
  }

  function preserveCurrent() {
    const current = readCurrentRaw();
    if (!current.ok) return quarantineCurrent();
    if (!current.exists) return { ok: true, exists: false, name: null };
    const backup = createBackup(current.raw);
    if (!backup.ok) return backup;
    return { ok: true, exists: true, name: backup.name };
  }

  function safeWriteAtomic(content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const tmp = path.join(dir, ".data-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ".tmp");
    let fd = null;
    try {
      fd = fsv.openSync(tmp, "w");
      fsv.writeFileSync(fd, data);
      fsv.fsyncSync(fd);
      fsv.closeSync(fd);
      fd = null;
      fsv.renameSync(tmp, file);
      try {
        const dirFd = fsv.openSync(dir, "r");
        try { fsv.fsyncSync(dirFd); } finally { fsv.closeSync(dirFd); }
      } catch (error) {
        void error;
      }
      return { ok: true };
    } catch (error) {
      if (fd !== null) {
        try { fsv.closeSync(fd); } catch (closeError) { void closeError; }
      }
      try { fsv.unlinkSync(tmp); } catch (unlinkError) { void unlinkError; }
      return { ok: false, code: "WRITE_FAILED", error: "تعذر حفظ ملف المعطيات. لم يتم تعديل الملف الأصلي." };
    }
  }

  function readCurrentRaw() {
    try {
      if (fsv.statSync(file).size > maxBytes) {
        return { ok: false, code: "TOO_LARGE", error: "حجم ملف المعطيات كبير جدا. لم يتم تعديل الملف." };
      }
      return { ok: true, exists: true, raw: fsv.readFileSync(file) };
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, exists: false, raw: null };
      return { ok: false, code: "READ_FAILED", error: "تعذر قراءة ملف المعطيات الحالي قبل الحفظ." };
    }
  }

  function load() {
    try {
      ensureDir();
    } catch (error) {
      locked = true;
      loadError = "تعذر الوصول إلى مجلد البيانات Documents/CentreData.";
      return { ok: false, code: "DATA_DIR_FAILED", error: loadError };
    }

    let info;
    try {
      info = fsv.statSync(file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        locked = false;
        loadError = "";
        return { ok: true, firstRun: true, data: null };
      }
      locked = true;
      loadError = "تعذر قراءة ملف المعطيات. تم إيقاف الحفظ لحماية البيانات.";
      return { ok: false, code: "READ_FAILED", error: loadError };
    }
    if (info.size > maxBytes) {
      locked = true;
      loadError = "حجم ملف المعطيات كبير جدا. لم يتم تعديل الملف وتم إيقاف الحفظ.";
      return { ok: false, code: "TOO_LARGE", error: loadError };
    }

    let raw;
    try {
      raw = fsv.readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        locked = false;
        loadError = "";
        return { ok: true, firstRun: true, data: null };
      }
      locked = true;
      loadError = "تعذر قراءة ملف المعطيات. تم إيقاف الحفظ لحماية البيانات.";
      return { ok: false, code: "READ_FAILED", error: loadError };
    }

    let parsed;
    try {
      parsed = JSON.parse(stripBom(raw));
    } catch (error) {
      locked = true;
      loadError = "ملف المعطيات غير صالح (JSON). لم يتم تعديل الملف وتم إيقاف الحفظ.";
      return { ok: false, code: "INVALID_JSON", error: loadError };
    }

    const checked = validation.validateData(parsed, { mode: "load" });
    if (!checked.ok) {
      locked = true;
      loadError = checked.error + ". لم يتم تعديل الملف وتم إيقاف الحفظ.";
      return { ok: false, code: "INVALID_DATA", error: loadError };
    }

    locked = false;
    loadError = "";
    return { ok: true, firstRun: false, data: checked.data };
  }

  function save(json) {
    if (locked) {
      return { ok: false, code: "LOCKED", error: "الحفظ موقوف لحماية البيانات. أصلح الملف الأصلي أو استرجع نسخة موثوقة." };
    }
    if (typeof json !== "string") {
      return { ok: false, code: "INVALID_INPUT", error: "بيانات الحفظ غير صالحة." };
    }
    if (Buffer.byteLength(json, "utf8") > maxBytes) {
      return { ok: false, code: "TOO_LARGE", error: "حجم البيانات كبير جدا." };
    }

    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return { ok: false, code: "INVALID_JSON", error: "تعذر حفظ البيانات: JSON غير صالح." };
    }
    const checked = validation.validateData(parsed, { mode: "load" });
    if (!checked.ok) {
      return { ok: false, code: "INVALID_DATA", error: checked.error };
    }

    const current = readCurrentRaw();
    if (!current.ok) return current;

    let backupName = null;
    if (current.exists) {
      if (current.raw.toString("utf8") === json) {
        return { ok: true, unchanged: true, backup: null };
      }
      const currentText = stripBom(current.raw.toString("utf8"));
      let currentParsed;
      try {
        currentParsed = JSON.parse(currentText);
      } catch (error) {
        locked = true;
        loadError = "ملف المعطيات الحالي غير صالح (JSON). لم يتم تعديل الملف وتم إيقاف الحفظ.";
        return { ok: false, code: "INVALID_JSON", error: loadError };
      }
      const currentChecked = validation.validateData(currentParsed, { mode: "load" });
      if (!currentChecked.ok) {
        locked = true;
        loadError = currentChecked.error + ". لم يتم تعديل الملف وتم إيقاف الحفظ.";
        return { ok: false, code: "INVALID_DATA", error: loadError };
      }
      const backup = createBackup(current.raw);
      if (!backup.ok) return backup;
      backupName = backup.name;
    }

    const written = safeWriteAtomic(json);
    if (!written.ok) return written;
    locked = false;
    loadError = "";
    return { ok: true, backup: backupName };
  }

  function listBackups() {
    try {
      ensureDir();
    } catch (error) {
      return { ok: false, code: "DATA_DIR_FAILED", error: "تعذر الوصول إلى مجلد البيانات." };
    }
    let names = [];
    try {
      names = fsv.readdirSync(backupDir);
    } catch (error) {
      return { ok: false, code: "BACKUP_LIST_FAILED", error: "تعذر قراءة مجلد النسخ الاحتياطية." };
    }
    const result = [];
    for (const name of names) {
      if (!BACKUP_RE.test(name)) continue;
      const target = path.join(backupDir, name);
      let size = 0;
      let modified = null;
      try {
        const stat = fsv.statSync(target);
        size = stat.size;
        modified = stat.mtime.toISOString();
      } catch (error) {
        result.push({ name: name, size: size, modified: modified, valid: false, error: "تعذر قراءة النسخة الاحتياطية." });
        continue;
      }
      if (size > maxBytes) {
        result.push({ name: name, size: size, modified: modified, valid: false, error: "حجم النسخة الاحتياطية كبير جدا." });
        continue;
      }
      try {
        const text = readText(target);
        const parsed = JSON.parse(text);
        const checked = validation.validateData(parsed, { mode: "load" });
        result.push({
          name: name,
          size: size,
          modified: modified,
          valid: checked.ok,
          error: checked.ok ? "" : checked.error,
        });
      } catch (error) {
        result.push({ name: name, size: size, modified: modified, valid: false, error: "ملف غير صالح" });
      }
    }
    result.sort(function (a, b) {
      return String(b.modified || "").localeCompare(String(a.modified || "")) || b.name.localeCompare(a.name);
    });
    return { ok: true, backups: result };
  }

  function validBackupName(name) {
    if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
    if (path.basename(name) !== name) return false;
    if (!BACKUP_RE.test(name)) return false;
    return path.resolve(path.join(backupDir, name)).indexOf(path.resolve(backupDir) + path.sep) === 0;
  }

  function restoreBackup(name) {
    if (!validBackupName(name)) {
      return { ok: false, code: "INVALID_BACKUP_NAME", error: "اسم النسخة الاحتياطية غير صالح." };
    }
    const target = path.join(backupDir, name);
    let info;
    try {
      info = fsv.statSync(target);
    } catch (error) {
      return { ok: false, code: "BACKUP_READ_FAILED", error: "تعذر قراءة النسخة الاحتياطية." };
    }
    if (info.size > maxBytes) {
      return { ok: false, code: "TOO_LARGE", error: "حجم النسخة الاحتياطية كبير جدا. لم يتم استرجاعها." };
    }
    let raw;
    try {
      raw = fsv.readFileSync(target);
    } catch (error) {
      return { ok: false, code: "BACKUP_READ_FAILED", error: "تعذر قراءة النسخة الاحتياطية." };
    }
    let parsed;
    try {
      parsed = JSON.parse(stripBom(raw.toString("utf8")));
    } catch (error) {
      return { ok: false, code: "INVALID_BACKUP", error: "النسخة الاحتياطية غير صالحة ولا يمكن استرجاعها." };
    }
    const checked = validation.validateData(parsed, { mode: "load" });
    if (!checked.ok) {
      return { ok: false, code: "INVALID_BACKUP", error: "النسخة الاحتياطية غير صالحة: " + checked.error };
    }

    const preserved = preserveCurrent();
    if (!preserved.ok) return preserved;
    const written = safeWriteAtomic(raw);
    if (!written.ok) return written;
    locked = false;
    loadError = "";
    return { ok: true, data: checked.data };
  }

  function restoreImportedData(input) {
    let parsed = input;
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > maxBytes) {
        return { ok: false, code: "TOO_LARGE", error: "حجم البيانات كبير جدا." };
      }
      try {
        parsed = JSON.parse(stripBom(input));
      } catch (error) {
        return { ok: false, code: "INVALID_JSON", error: "الملف المستورد ليس JSON صالحا." };
      }
    }
    const checked = validation.validateData(parsed, { mode: "import" });
    if (!checked.ok) return { ok: false, code: "INVALID_DATA", error: checked.error };

    const preserved = preserveCurrent();
    if (!preserved.ok) return preserved;
    const written = safeWriteAtomic(JSON.stringify(checked.data));
    if (!written.ok) return written;
    locked = false;
    loadError = "";
    return { ok: true, data: checked.data };
  }

  function isLocked() {
    return locked;
  }

  function getLoadError() {
    return loadError;
  }

  return {
    paths: paths,
    ensureDir: ensureDir,
    load: load,
    save: save,
    listBackups: listBackups,
    restoreBackup: restoreBackup,
    restoreImportedData: restoreImportedData,
    isLocked: isLocked,
    getLoadError: getLoadError,
  };
}

module.exports = { createStore: createStore };
