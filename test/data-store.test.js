const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../data-store");

function base(name) {
  return {
    students: [{
      id: "s1",
      name: name || "أحمد",
      phone: "0612345678",
      lvl: "الأول ابتدائي",
      note: "",
      date: "2026-01-01",
    }],
    regs: [{
      id: "r1",
      sid: "s1",
      act: "دعم مدرسي",
      sub: "الرياضيات",
      lvl: "الأول ابتدائي",
      fee: 200,
      on: true,
      date: "2026-01-01",
    }],
    att: { "2026-01-02": { r1: true } },
    pays: [{
      id: "p1",
      rid: "r1",
      month: "2026-01",
      n: 1,
      amt: 200,
      date: "2026-01-02",
    }],
    prices: { "دعم مدرسي|الرياضيات": 200 },
    subjects: [],
    cfg: { name: "المركز", logo: "" },
  };
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  const store = createStore({
    dir,
    now: () => new Date(2026, 0, 1, 10, 0, 0, 0),
  });
  store.ensureDir();
  return { dir, store, file: path.join(dir, "data.json"), backupDir: path.join(dir, "backups") };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeRecoveryStore(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  const file = path.join(dir, "data.json");
  const backupDir = path.join(dir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const oversized = "x".repeat(opts.size || 8192);
  fs.writeFileSync(file, oversized, "utf8");
  const store = createStore({
    dir,
    fs: opts.fs,
    maxBytes: opts.maxBytes || 4096,
    now: () => new Date(2026, 0, 1, 10, 0, 0, 0),
  });
  store.ensureDir();
  return { dir, store, file, backupDir, oversized };
}

test("first run loads empty and the first save creates no backup", () => {
  const { dir, store, file, backupDir } = makeStore();
  try {
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.firstRun, true);

    const data = base();
    const saved = store.save(JSON.stringify(data));
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.backup, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), data);
    assert.deepEqual(fs.readdirSync(backupDir), []);
  } finally {
    cleanup(dir);
  }
});

test("saves create backups of the previous file without deleting them", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    const first = base("الأول");
    const second = { ...base("الثاني") };
    second.prices = { "دعم مدرسي|الرياضيات": 250 };

    assert.equal(store.save(JSON.stringify(first)).ok, true);
    const saved = store.save(JSON.stringify(second));
    assert.equal(saved.ok, true, saved.error);
    assert.match(saved.backup, /^data-.+\.json$/);

    const list = store.listBackups();
    assert.equal(list.ok, true);
    assert.equal(list.backups.length, 1);
    assert.equal(list.backups[0].valid, true);

    const backupPath = path.join(backupDir, list.backups[0].name);
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), first);
  } finally {
    cleanup(dir);
  }
});

test("unchanged saves are no-ops and duplicate backups are skipped", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    const first = base("الأول");
    const second = { ...base("الثاني") };
    assert.equal(store.save(JSON.stringify(first)).ok, true);
    assert.equal(store.save(JSON.stringify(first)).unchanged, true);
    assert.equal(fs.readdirSync(backupDir).length, 0);

    assert.equal(store.save(JSON.stringify(second)).ok, true);
    assert.equal(store.save(JSON.stringify(first)).ok, true);
    assert.equal(fs.readdirSync(backupDir).length, 2);
    assert.equal(store.save(JSON.stringify(second)).ok, true);
    assert.equal(fs.readdirSync(backupDir).length, 2);
  } finally {
    cleanup(dir);
  }
});

test("an invalid current file locks all saves", () => {
  const { dir, store, file } = makeStore();
  try {
    fs.writeFileSync(file, "{ not json", "utf8");
    const loaded = store.load();
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, "INVALID_JSON");

    const saved = store.save(JSON.stringify(base()));
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "LOCKED");
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup backs up current data, validates the backup and never deletes backups", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    const first = base("الأول");
    const second = base("الثاني");
    const third = base("الثالث");
    assert.equal(store.save(JSON.stringify(first)).ok, true);
    assert.equal(store.save(JSON.stringify(second)).ok, true);
    assert.equal(store.save(JSON.stringify(third)).ok, true);

    const list = store.listBackups();
    const firstBackup = list.backups.find((item) => {
      const value = JSON.parse(fs.readFileSync(path.join(backupDir, item.name), "utf8"));
      return value.students[0].name === "الأول";
    });
    assert.ok(firstBackup);
    const before = fs.readdirSync(backupDir).length;

    const restored = store.restoreBackup(firstBackup.name);
    assert.equal(restored.ok, true, restored.error);
    assert.equal(restored.data.students[0].name, "الأول");
    assert.equal(store.load().data.students[0].name, "الأول");
    assert.ok(fs.readdirSync(backupDir).length >= before);
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup rejects traversal and invalid backup files", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    assert.equal(store.restoreBackup("../data.json").ok, false);
    assert.equal(store.restoreBackup("data-missing.json").ok, false);

    fs.writeFileSync(path.join(backupDir, "data-bad.json"), "{bad", "utf8");
    const listed = store.listBackups();
    assert.equal(listed.ok, true);
    assert.equal(listed.backups[0].valid, false);
    const restored = store.restoreBackup("data-bad.json");
    assert.equal(restored.ok, false);
    assert.equal(restored.code, "INVALID_BACKUP");
  } finally {
    cleanup(dir);
  }
});

test("restoreImportedData normalizes imports and backs up current data", () => {
  const { dir, store } = makeStore();
  try {
    const current = base("الحالي");
    assert.equal(store.save(JSON.stringify(current)).ok, true);

    const imported = base("المستورد");
    imported.futureField = "ignored";
    imported.students[0].extra = "ignored";
    const result = store.restoreImportedData(JSON.stringify(imported));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.students[0].name, "المستورد");
    assert.equal(Object.hasOwn(result.data, "futureField"), false);
    assert.equal(Object.hasOwn(result.data.students[0], "extra"), false);
    assert.equal(store.load().data.students[0].name, "المستورد");
    assert.equal(store.listBackups().backups.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("save then load from a new store instance returns the same data", () => {
  const { dir, store } = makeStore();
  try {
    const data = base("أحمد");
    assert.equal(store.save(JSON.stringify(data)).ok, true);

    const reopened = createStore({
      dir,
      now: () => new Date(2026, 0, 1, 10, 0, 0, 0),
    });
    const loaded = reopened.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.firstRun, false);
    assert.deepEqual(loaded.data, data);
  } finally {
    cleanup(dir);
  }
});

test("custom subjects survive save, load, backup, import and restore", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    const first = base("الأول");
    first.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
    first.prices["دعم مدرسي|المعلوميات"] = 250;
    assert.equal(store.save(JSON.stringify(first)).ok, true);

    const reopened = createStore({
      dir,
      now: () => new Date(2026, 0, 1, 10, 0, 0, 0),
    });
    const loaded = reopened.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.deepEqual(loaded.data.subjects, first.subjects);
    assert.equal(loaded.data.prices["دعم مدرسي|المعلوميات"], 250);

    const second = base("الثاني");
    second.subjects = first.subjects;
    second.prices = Object.assign({}, first.prices);
    assert.equal(reopened.save(JSON.stringify(second)).ok, true);
    const backup = reopened.listBackups().backups.find((item) => {
      const saved = JSON.parse(fs.readFileSync(path.join(backupDir, item.name), "utf8"));
      return saved.students[0].name === "الأول";
    });
    assert.ok(backup);

    const imported = base("المستورد");
    imported.subjects = [{ id: "sub2", act: "لغات", name: "البرتغالية" }];
    imported.prices["لغات|البرتغالية"] = 300;
    const importedResult = reopened.restoreImportedData(JSON.stringify(imported));
    assert.equal(importedResult.ok, true, importedResult.error);
    assert.deepEqual(reopened.load().data.subjects, imported.subjects);
    assert.equal(reopened.load().data.prices["لغات|البرتغالية"], 300);

    const restored = reopened.restoreBackup(backup.name);
    assert.equal(restored.ok, true, restored.error);
    assert.deepEqual(restored.data.subjects, first.subjects);
    assert.equal(restored.data.prices["دعم مدرسي|المعلوميات"], 250);
  } finally {
    cleanup(dir);
  }
});

test("loading legacy data without subjects supplies an empty catalog", () => {
  const { dir, store } = makeStore();
  try {
    const legacy = base("قديم");
    delete legacy.subjects;
    assert.equal(store.save(JSON.stringify(legacy)).ok, true);
    const loaded = store.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.deepEqual(loaded.data.subjects, []);
  } finally {
    cleanup(dir);
  }
});

test("a crash during the atomic write leaves the previous data.json intact", () => {
  const { dir, store, file } = makeStore();
  try {
    const first = base("الأول");
    const second = base("الثاني");
    assert.equal(store.save(JSON.stringify(first)).ok, true);
    const before = fs.readFileSync(file, "utf8");

    const crashFs = Object.create(fs);
    crashFs.renameSync = function (from, to) {
      if (to === file) {
        const error = new Error("simulated crash before rename");
        error.code = "EIO";
        throw error;
      }
      return fs.renameSync(from, to);
    };

    const crashing = createStore({
      dir,
      fs: crashFs,
      now: () => new Date(2026, 0, 1, 10, 1, 0, 0),
    });
    const saved = crashing.save(JSON.stringify(second));
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "WRITE_FAILED");
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);

    const reopened = createStore({ dir });
    const loaded = reopened.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.data.students[0].name, "الأول");
  } finally {
    cleanup(dir);
  }
});

test("a corrupted data.json is refused and never overwritten", () => {
  const { dir, store, file } = makeStore();
  try {
    const corrupted = "{ not json";
    fs.writeFileSync(file, corrupted, "utf8");

    const loaded = store.load();
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, "INVALID_JSON");
    assert.equal(store.save(JSON.stringify(base())).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), corrupted);

    const direct = createStore({ dir, now: () => new Date(2026, 0, 1, 10, 0, 0, 0) });
    const saved = direct.save(JSON.stringify(base()));
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "INVALID_JSON");
    assert.equal(fs.readFileSync(file, "utf8"), corrupted);
  } finally {
    cleanup(dir);
  }
});

test("schema-invalid data.json is also refused before an overwrite", () => {
  const { dir, store, file } = makeStore();
  try {
    const invalid = JSON.stringify({ students: "not a list", regs: [], att: {}, pays: [] });
    fs.writeFileSync(file, invalid, "utf8");

    const saved = store.save(JSON.stringify(base()));
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "INVALID_DATA");
    assert.equal(fs.readFileSync(file, "utf8"), invalid);
  } finally {
    cleanup(dir);
  }
});

test("load refuses an oversized data file and locks saving without overwriting it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  try {
    const file = path.join(dir, "data.json");
    const oversized = "x".repeat(1025);
    fs.writeFileSync(file, oversized, "utf8");
    const store = createStore({ dir, maxBytes: 1024, now: () => new Date(2026, 0, 1, 10, 0, 0, 0) });
    store.ensureDir();

    const loaded = store.load();
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, "TOO_LARGE");
    assert.match(loaded.error, /كبير جدا/);
    assert.equal(store.isLocked(), true);

    const saved = store.save(JSON.stringify(base()));
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "LOCKED");
    assert.equal(fs.readFileSync(file, "utf8"), oversized);
  } finally {
    cleanup(dir);
  }
});

test("listBackups marks an oversized backup invalid without reading it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  try {
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const bigName = "data-big.json";
    const smallName = "data-small.json";
    const bigPath = path.join(backupDir, bigName);
    fs.writeFileSync(bigPath, "x".repeat(1025), "utf8");
    fs.writeFileSync(path.join(backupDir, smallName), JSON.stringify(base()), "utf8");

    let readBig = false;
    const tracked = Object.create(fs);
    tracked.readFileSync = function (target) {
      if (target === bigPath) readBig = true;
      return fs.readFileSync.apply(fs, arguments);
    };
    const store = createStore({ dir, fs: tracked, maxBytes: 1024 });

    const listed = store.listBackups();
    assert.equal(listed.ok, true);
    const big = listed.backups.find((item) => item.name === bigName);
    const small = listed.backups.find((item) => item.name === smallName);
    assert.ok(big);
    assert.ok(small);
    assert.equal(big.valid, false);
    assert.match(big.error, /كبير جدا/);
    assert.equal(small.valid, true);
    assert.equal(readBig, false);
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup refuses an oversized backup before reading it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  try {
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const bigPath = path.join(backupDir, "data-big.json");
    fs.writeFileSync(bigPath, "x".repeat(1025), "utf8");

    let readBig = false;
    const tracked = Object.create(fs);
    tracked.readFileSync = function (target) {
      if (target === bigPath) readBig = true;
      return fs.readFileSync.apply(fs, arguments);
    };
    const store = createStore({ dir, fs: tracked, maxBytes: 1024 });

    const restored = store.restoreBackup("data-big.json");
    assert.equal(restored.ok, false);
    assert.equal(restored.code, "TOO_LARGE");
    assert.match(restored.error, /كبير جدا/);
    assert.equal(readBig, false);
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup recovers an oversized current file and quarantines it", () => {
  const { dir, store, file, backupDir, oversized } = makeRecoveryStore();
  try {
    const replacement = base("النسخة");
    fs.writeFileSync(path.join(backupDir, "data-valid.json"), JSON.stringify(replacement), "utf8");

    const restored = store.restoreBackup("data-valid.json");
    assert.equal(restored.ok, true, restored.error);
    assert.equal(restored.data.students[0].name, "النسخة");

    const loaded = store.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.data.students[0].name, "النسخة");
    assert.equal(store.isLocked(), false);

    const quarantined = fs.readdirSync(backupDir).filter((name) => name.startsWith("data-damaged-"));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(backupDir, quarantined[0]), "utf8"), oversized);
    assert.notEqual(fs.readFileSync(file, "utf8"), oversized);
  } finally {
    cleanup(dir);
  }
});

test("restoreImportedData recovers an oversized current file and quarantines it", () => {
  const { dir, store, file, backupDir, oversized } = makeRecoveryStore();
  try {
    const imported = base("المستورد");
    const result = store.restoreImportedData(JSON.stringify(imported));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.students[0].name, "المستورد");

    const loaded = store.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.data.students[0].name, "المستورد");
    assert.equal(store.isLocked(), false);

    const quarantined = fs.readdirSync(backupDir).filter((name) => name.startsWith("data-damaged-"));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(backupDir, quarantined[0]), "utf8"), oversized);
    assert.notEqual(fs.readFileSync(file, "utf8"), oversized);
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup recovers a corrupted current file and preserves the corrupted bytes", () => {
  const { dir, store, file, backupDir } = makeStore();
  try {
    const corrupted = "{ not json";
    fs.writeFileSync(file, corrupted, "utf8");
    const replacement = base("النسخة");
    fs.writeFileSync(path.join(backupDir, "data-valid.json"), JSON.stringify(replacement), "utf8");

    const restored = store.restoreBackup("data-valid.json");
    assert.equal(restored.ok, true, restored.error);
    assert.equal(store.load().data.students[0].name, "النسخة");

    const preserved = fs.readdirSync(backupDir).some((name) => {
      return fs.readFileSync(path.join(backupDir, name), "utf8") === corrupted;
    });
    assert.equal(preserved, true);
  } finally {
    cleanup(dir);
  }
});

test("invalid backups and imports never replace an oversized current file", () => {
  const { dir, store, file, backupDir, oversized } = makeRecoveryStore();
  try {
    fs.writeFileSync(path.join(backupDir, "data-bad.json"), "{bad", "utf8");
    const restored = store.restoreBackup("data-bad.json");
    assert.equal(restored.ok, false);
    assert.equal(restored.code, "INVALID_BACKUP");
    assert.equal(fs.readFileSync(file, "utf8"), oversized);
    assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith("data-damaged-")), false);

    const imported = store.restoreImportedData("{bad");
    assert.equal(imported.ok, false);
    assert.equal(imported.code, "INVALID_JSON");
    assert.equal(fs.readFileSync(file, "utf8"), oversized);
    assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith("data-damaged-")), false);
  } finally {
    cleanup(dir);
  }
});

test("a filesystem error during recovery leaves the oversized original intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  try {
    const file = path.join(dir, "data.json");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const oversized = "x".repeat(8192);
    fs.writeFileSync(file, oversized, "utf8");
    const replacement = base("النسخة");
    fs.writeFileSync(path.join(backupDir, "data-valid.json"), JSON.stringify(replacement), "utf8");

    const crashFs = Object.create(fs);
    crashFs.renameSync = function (from, to) {
      if (to === file) {
        const error = new Error("simulated interrupted recovery");
        error.code = "EIO";
        throw error;
      }
      return fs.renameSync(from, to);
    };
    const store = createStore({
      dir,
      fs: crashFs,
      maxBytes: 4096,
      now: () => new Date(2026, 0, 1, 10, 0, 0, 0),
    });

    const failed = store.restoreBackup("data-valid.json");
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "WRITE_FAILED");
    assert.equal(fs.readFileSync(file, "utf8"), oversized);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);

    const quarantined = fs.readdirSync(backupDir).filter((name) => name.startsWith("data-damaged-"));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(backupDir, quarantined[0]), "utf8"), oversized);

    const reopened = createStore({ dir, maxBytes: 4096, now: () => new Date(2026, 0, 1, 10, 1, 0, 0) });
    const retried = reopened.restoreBackup("data-valid.json");
    assert.equal(retried.ok, true, retried.error);
    assert.equal(reopened.load().data.students[0].name, "النسخة");
  } finally {
    cleanup(dir);
  }
});

test("a quarantine failure aborts recovery without touching the current file", () => {
  const deniedFs = Object.create(fs);
  deniedFs.copyFileSync = function () {
    const error = new Error("simulated permission error");
    error.code = "EACCES";
    throw error;
  };
  const { dir, store, file, backupDir, oversized } = makeRecoveryStore({ fs: deniedFs });
  try {
    const replacement = base("النسخة");
    fs.writeFileSync(path.join(backupDir, "data-valid.json"), JSON.stringify(replacement), "utf8");

    const restored = store.restoreBackup("data-valid.json");
    assert.equal(restored.ok, false);
    assert.equal(restored.code, "RECOVERY_BACKUP_FAILED");
    assert.equal(fs.readFileSync(file, "utf8"), oversized);
    assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith("data-damaged-")), false);
  } finally {
    cleanup(dir);
  }
});

test("restoreBackup recovers an unreadable current file by quarantining it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-store-"));
  try {
    const file = path.join(dir, "data.json");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const current = JSON.stringify(base("الحالي"));
    fs.writeFileSync(file, current, "utf8");
    const replacement = base("النسخة");
    fs.writeFileSync(path.join(backupDir, "data-valid.json"), JSON.stringify(replacement), "utf8");

    const deniedFs = Object.create(fs);
    deniedFs.readFileSync = function (target) {
      if (target === file) {
        const error = new Error("simulated read denial");
        error.code = "EACCES";
        throw error;
      }
      return fs.readFileSync.apply(fs, arguments);
    };
    const store = createStore({ dir, fs: deniedFs, now: () => new Date(2026, 0, 1, 10, 0, 0, 0) });

    const restored = store.restoreBackup("data-valid.json");
    assert.equal(restored.ok, true, restored.error);
    const reopened = createStore({ dir });
    const loaded = reopened.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.data.students[0].name, "النسخة");

    const quarantined = fs.readdirSync(backupDir).filter((name) => name.startsWith("data-damaged-"));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(backupDir, quarantined[0]), "utf8"), current);
  } finally {
    cleanup(dir);
  }
});

test("normal restore still backs up a healthy current file without quarantining it", () => {
  const { dir, store, backupDir } = makeStore();
  try {
    assert.equal(store.save(JSON.stringify(base("الأول"))).ok, true);
    assert.equal(store.save(JSON.stringify(base("الثاني"))).ok, true);
    const before = fs.readdirSync(backupDir).length;
    const target = store.listBackups().backups.find((item) => {
      return JSON.parse(fs.readFileSync(path.join(backupDir, item.name), "utf8")).students[0].name === "الأول";
    });
    assert.ok(target);

    const restored = store.restoreBackup(target.name);
    assert.equal(restored.ok, true, restored.error);
    assert.equal(store.load().data.students[0].name, "الأول");
    assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith("data-damaged-")), false);
    assert.ok(fs.readdirSync(backupDir).length > before);
  } finally {
    cleanup(dir);
  }
});
