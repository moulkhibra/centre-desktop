"use strict";

/**
 * Phase 4B startup-order integration tests.
 *
 * These tests execute the real `main.js` in an isolated VM context with mocked
 * Electron and a mocked startup license gate. They do not launch Electron or
 * touch the real Documents directory.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const mainPath = path.join(root, "main.js");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function snapshot(directory) {
  return {
    entries: fs.readdirSync(directory).sort(),
    files: fs.readdirSync(directory).sort().map((name) => {
      const absolute = path.join(directory, name);
      return [name, fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : null];
    }),
  };
}

function loadMain(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-startup-"));
  const documentsDir = path.join(dir, "Documents");
  const profileDir = path.join(dir, "profile");
  const expectedDataDir = path.join(documentsDir, "CentreData");

  const events = [];
  const dialogs = [];
  const quitCalls = [];
  const errors = [];
  const ipcHandlers = Object.create(null);
  const ipcListeners = Object.create(null);
  const gateCalls = [];
  const sessionCalls = [];
  const appHandlers = Object.create(null);
  let windowOptions = null;
  let destroyed = false;

  const frame = { url: pathToFileURL(path.join(root, "index.html")).href };
  const webContents = {
    mainFrame: frame,
    send() {},
    on() {},
    setWindowOpenHandler() {},
  };

  const window = {
    webContents,
    isDestroyed() {
      return destroyed;
    },
    isMinimized() {
      return false;
    },
    restore() {},
    show() {},
    focus() {},
    loadFile() {
      return Promise.resolve();
    },
    on(event, handler) {
      if (!this._handlers) this._handlers = Object.create(null);
      this._handlers[event] = handler;
    },
    close() {
      destroyed = true;
      if (this._handlers && this._handlers.closed) this._handlers.closed();
    },
  };

  const app = {
    isPackaged: true,
    requestSingleInstanceLock() {
      return true;
    },
    quit() {
      quitCalls.push(true);
    },
    getPath(name) {
      if (name === "documents") return documentsDir;
      if (name === "userData") return profileDir;
      return dir;
    },
    whenReady() {
      return Promise.resolve();
    },
    on(event, handler) {
      if (!appHandlers[event]) appHandlers[event] = [];
      appHandlers[event].push(handler);
    },
  };

  const electron = {
    app: app,
    BrowserWindow: function (browserWindowOptions) {
      windowOptions = browserWindowOptions;
      events.push("window");
      return window;
    },
    ipcMain: {
      handle(channel, handler) {
        events.push("ipc:" + channel);
        ipcHandlers[channel] = handler;
      },
      on(channel, handler) {
        events.push("ipc-on:" + channel);
        if (!ipcListeners[channel]) ipcListeners[channel] = [];
        ipcListeners[channel].push(handler);
      },
    },
    shell: {
      showItemInFolder() {},
      openPath() {
        return Promise.resolve("");
      },
      openExternal() {
        return Promise.resolve();
      },
    },
    Menu: {
      setApplicationMenu() {
        events.push("menu");
      },
    },
    dialog: {
      showErrorBox(title, detail) {
        events.push("dialog");
        dialogs.push({ title: title, detail: detail });
      },
      showMessageBox() {
        return Promise.resolve({ response: 0 });
      },
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived(handler) {
            events.push("session:csp");
            sessionCalls.push({ name: "csp", handler: handler });
          },
        },
        setPermissionRequestHandler(handler) {
          events.push("session:permission-request");
          sessionCalls.push({ name: "permission-request", handler: handler });
        },
        setPermissionCheckHandler(handler) {
          events.push("session:permission-check");
          sessionCalls.push({ name: "permission-check", handler: handler });
        },
      },
    },
  };

  const storeState = { ensured: 0, saved: [], dir: null };
  const store = {
    ensureDir() {
      storeState.ensured += 1;
      events.push("ensureDir");
    },
    load() {
      return { ok: true, firstRun: true };
    },
    listBackups() {
      return { ok: true, backups: [] };
    },
    save(json) {
      storeState.saved.push(json);
      return { ok: true };
    },
    restoreBackup() {
      return { ok: true };
    },
    restoreImportedData() {
      return { ok: true };
    },
  };

  const fakeStartupLicense = {
    verifyStartupLicense: async function (gateOptions) {
      events.push("gate");
      gateCalls.push(gateOptions);
      if (opts.gateThrows) throw new Error("simulated gate failure");
      if (Object.prototype.hasOwnProperty.call(opts, "gateResult")) return opts.gateResult;
      return { ok: true, data: { license: { licenseId: "test-license" } } };
    },
  };

  const fakeRequire = function (id) {
    if (id === "electron") return electron;
    if (id === "./startup-license") return fakeStartupLicense;
    if (id === "./data-store") {
      return {
        createStore(createOptions) {
          events.push("createStore");
          storeState.dir = createOptions && createOptions.dir;
          return store;
        },
      };
    }
    if (id.startsWith(".")) return require(path.join(root, id));
    return require(id);
  };

  const context = {
    require: fakeRequire,
    __dirname: root,
    __filename: mainPath,
    process: process,
    Buffer: Buffer,
    URL: URL,
    console: {
      log() {},
      error(message) {
        errors.push(String(message));
      },
    },
    setTimeout: function (handler, ms) {
      return setTimeout(handler, Math.min(ms, 25));
    },
    clearTimeout: clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(mainPath, "utf8"), context, { filename: mainPath });

  return {
    dir: dir,
    documentsDir: documentsDir,
    profileDir: profileDir,
    expectedDataDir: expectedDataDir,
    events: events,
    dialogs: dialogs,
    quitCalls: quitCalls,
    errors: errors,
    ipcHandlers: ipcHandlers,
    ipcListeners: ipcListeners,
    gateCalls: gateCalls,
    sessionCalls: sessionCalls,
    appHandlers: appHandlers,
    window: window,
    windowOptions() {
      return windowOptions;
    },
    storeState: storeState,
    async ready() {
      await tick();
      await tick();
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function eventIndex(events, name) {
  return events.indexOf(name);
}

test("successful startup verifies the license before any data-store work", async (t) => {
  const harness = loadMain();
  try {
    await harness.ready();

    const gate = eventIndex(harness.events, "gate");
    const createStore = eventIndex(harness.events, "createStore");
    const ensureDir = eventIndex(harness.events, "ensureDir");
    const firstIpc = harness.events.findIndex((event) => event.startsWith("ipc"));
    const window = eventIndex(harness.events, "window");

    assert.notEqual(gate, -1);
    assert.notEqual(createStore, -1);
    assert.notEqual(ensureDir, -1);
    assert.notEqual(firstIpc, -1);
    assert.notEqual(window, -1);
    assert.ok(gate < createStore, JSON.stringify(harness.events));
    assert.ok(createStore < ensureDir, JSON.stringify(harness.events));
    assert.ok(ensureDir < firstIpc, JSON.stringify(harness.events));
    assert.ok(firstIpc < window, JSON.stringify(harness.events));

    assert.equal(harness.dialogs.length, 0);
    assert.equal(harness.quitCalls.length, 0);
    assert.equal(harness.gateCalls.length, 1);
    assert.deepEqual(
      { dataDir: harness.gateCalls[0].dataDir, userDataDir: harness.gateCalls[0].userDataDir },
      {
        dataDir: harness.expectedDataDir,
        userDataDir: harness.profileDir,
      }
    );
    assert.equal(harness.storeState.dir, harness.expectedDataDir);
    assert.equal(harness.storeState.ensured, 1);
  } finally {
    harness.cleanup();
  }
});

test("successful startup preserves Electron security settings and adds no license IPC", async (t) => {
  const harness = loadMain();
  try {
    await harness.ready();

    const options = harness.windowOptions();
    assert.notEqual(options, null);
    assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.webSecurity, true);
    assert.equal(options.webPreferences.allowRunningInsecureContent, false);
    assert.equal(options.webPreferences.webviewTag, false);

    assert.equal(
      harness.sessionCalls.some((call) => call.name === "csp"),
      true
    );
    assert.equal(
      harness.sessionCalls.some((call) => call.name === "permission-request"),
      true
    );
    assert.equal(
      harness.sessionCalls.some((call) => call.name === "permission-check"),
      true
    );

    const channels = Object.keys(harness.ipcHandlers).sort();
    assert.deepEqual(channels, [
      "list-backups",
      "load",
      "open-data-folder",
      "restore-backup",
      "restore-imported-data",
      "save",
    ]);
    assert.equal(
      channels.some((channel) => /license|activation|trusted/i.test(channel)),
      false
    );
  } finally {
    harness.cleanup();
  }
});

test("a missing license shows the activation dialog and never starts the data store", async (t) => {
  const harness = loadMain({ gateResult: { ok: false, code: "LICENSE_MISSING" } });
  try {
    fs.mkdirSync(harness.expectedDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(harness.expectedDataDir, "centre-data.json"),
      "sentinel-data",
      "utf8"
    );
    const before = snapshot(harness.expectedDataDir);

    await harness.ready();

    assert.equal(harness.dialogs.length, 1);
    assert.equal(harness.dialogs[0].title, "تعذر تفعيل Centre");
    assert.ok(harness.dialogs[0].detail.includes("لا يوجد ترخيص"));
    assert.equal(harness.quitCalls.length, 1);
    assert.equal(harness.storeState.ensured, 0);
    assert.equal(harness.storeState.dir, null);
    assert.equal(harness.events.includes("createStore"), false);
    assert.equal(harness.events.includes("ensureDir"), false);
    assert.equal(harness.events.includes("window"), false);
    assert.equal(harness.events.some((event) => event.startsWith("ipc")), false);
    assert.deepEqual(snapshot(harness.expectedDataDir), before);
  } finally {
    harness.cleanup();
  }
});

test("an unconfigured production key fails closed before the data store", async (t) => {
  const harness = loadMain({
    gateResult: { ok: false, code: "PRODUCTION_KEY_NOT_CONFIGURED" },
  });
  try {
    await harness.ready();

    assert.equal(harness.dialogs.length, 1);
    assert.ok(harness.dialogs[0].detail.includes("مفتاح الترخيص"));
    assert.equal(harness.quitCalls.length, 1);
    assert.equal(harness.events.includes("createStore"), false);
    assert.equal(harness.events.includes("ensureDir"), false);
    assert.equal(harness.events.includes("window"), false);
  } finally {
    harness.cleanup();
  }
});

test("a device-mismatched license shows a clear dialog and touches no data", async (t) => {
  const harness = loadMain({ gateResult: { ok: false, code: "DEVICE_MISMATCH" } });
  try {
    fs.mkdirSync(harness.expectedDataDir, { recursive: true });
    fs.writeFileSync(path.join(harness.expectedDataDir, "centre-data.json"), "sentinel-data", "utf8");
    const before = snapshot(harness.expectedDataDir);

    await harness.ready();

    assert.equal(harness.dialogs.length, 1);
    assert.ok(harness.dialogs[0].detail.includes("حاسوب آخر"));
    assert.equal(harness.quitCalls.length, 1);
    assert.equal(harness.events.includes("createStore"), false);
    assert.deepEqual(snapshot(harness.expectedDataDir), before);
  } finally {
    harness.cleanup();
  }
});

test("a not-yet-valid license has its own activation message", async (t) => {
  const harness = loadMain({
    gateResult: { ok: false, code: "LICENSE_INVALID", cause: "NOT_YET_VALID" },
  });
  try {
    await harness.ready();

    assert.equal(harness.dialogs.length, 1);
    assert.ok(harness.dialogs[0].detail.includes("غير ساري بعد"));
    assert.equal(harness.quitCalls.length, 1);
    assert.equal(harness.events.includes("createStore"), false);
  } finally {
    harness.cleanup();
  }
});

test("a throwing gate is handled safely and never starts the data store", async (t) => {
  const harness = loadMain({ gateThrows: true });
  try {
    await harness.ready();

    assert.equal(harness.dialogs.length, 1);
    assert.ok(harness.dialogs[0].detail.includes("تعذر إكمال التحقق"));
    assert.equal(harness.quitCalls.length, 1);
    assert.equal(harness.events.includes("createStore"), false);
    assert.equal(harness.events.includes("ensureDir"), false);
    assert.equal(harness.events.includes("window"), false);
  } finally {
    harness.cleanup();
  }
});
