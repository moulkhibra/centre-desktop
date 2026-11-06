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

function createStore(options) {
  const saved = [];
  return {
    saved,
    store: {
      ensureDir() {},
      load() {
        return { ok: true, firstRun: true };
      },
      listBackups() {
        return { ok: true, backups: [] };
      },
      save(json) {
        if (options.save) return options.save(json);
        saved.push(json);
        return { ok: true };
      },
      restoreBackup() {
        return { ok: true };
      },
      restoreImportedData() {
        return { ok: true };
      },
    },
  };
}

function loadMain(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-main-"));
  const appHandlers = Object.create(null);
  const ipcHandlers = Object.create(null);
  const ipcListeners = Object.create(null);
  const winHandlers = Object.create(null);
  const sent = [];
  const errors = [];
  const quitCalls = [];
  const closeCalls = [];
  let destroyed = false;

  const frame = {
    url: pathToFileURL(path.join(root, "index.html")).href,
  };
  const webContents = {
    mainFrame: frame,
    send(channel) {
      sent.push(channel);
    },
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
      winHandlers[event] = handler;
    },
    close() {
      closeCalls.push(true);
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      winHandlers.close(event);
      if (event.prevented) return;
      destroyed = true;
      if (winHandlers.closed) winHandlers.closed();
    },
  };

  const app = {
    requestSingleInstanceLock() {
      return true;
    },
    quit() {
      quitCalls.push(true);
    },
    getPath() {
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
    BrowserWindow: function () {
      return window;
    },
    ipcMain: {
      handle(channel, handler) {
        ipcHandlers[channel] = handler;
      },
      on(channel, handler) {
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
      setApplicationMenu() {},
    },
    dialog: {
      showErrorBox() {},
      showMessageBox() {
        return Promise.resolve({ response: 0 });
      },
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived() {},
        },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
    },
  };

  const storeMock = createStore(opts);
  const fakeRequire = function (id) {
    if (id === "electron") return electron;
    if (id === "./data-store") return { createStore: () => storeMock.store };
    if (id === "./startup-license") {
      return {
        verifyStartupLicense: async function () {
          return { ok: true, data: { license: { licenseId: "test-license" } } };
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

  function trustedEvent() {
    return { sender: webContents, senderFrame: frame };
  }

  function fireClose() {
    window.close();
  }

  function fireBeforeQuit() {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    for (const handler of appHandlers["before-quit"] || []) handler(event);
    return event;
  }

  function closeReady() {
    for (const handler of ipcListeners["close-ready"] || []) handler(trustedEvent());
  }

  async function save(json) {
    return ipcHandlers.save(trustedEvent(), json);
  }

  return {
    dir,
    window,
    sent,
    errors,
    quitCalls,
    closeCalls,
    storeMock,
    fireClose,
    fireBeforeQuit,
    closeReady,
    save,
    ready() {
      return tick();
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a renderer save submitted after close begins is accepted before the queue closes", async () => {
  const harness = loadMain();
  try {
    await harness.ready();

    harness.fireClose();
    assert.equal(harness.window.isDestroyed(), false);
    assert.equal(harness.sent.filter((channel) => channel === "app-closing").length, 1);

    const saved = await harness.save('{"students":[]}');
    assert.equal(saved.ok, true);
    assert.deepEqual(harness.storeMock.saved, ['{"students":[]}']);

    harness.closeReady();
    await harness.ready();
    assert.equal(harness.window.isDestroyed(), true);
    assert.equal(harness.closeCalls.length, 2);
  } finally {
    harness.cleanup();
  }
});

test("repeated close requests are ignored until the first shutdown finishes", async () => {
  const harness = loadMain();
  try {
    await harness.ready();

    harness.fireClose();
    harness.fireClose();
    harness.fireClose();
    assert.equal(harness.window.isDestroyed(), false);
    assert.equal(harness.sent.filter((channel) => channel === "app-closing").length, 1);
    assert.equal(harness.closeCalls.length, 3);

    const saved = await harness.save('{"students":[]}');
    assert.equal(saved.ok, true);

    harness.closeReady();
    await harness.ready();
    assert.equal(harness.window.isDestroyed(), true);
    assert.equal(harness.sent.filter((channel) => channel === "app-closing").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("application quit flushes the renderer before closing the queue", async () => {
  const harness = loadMain();
  try {
    await harness.ready();

    const event = harness.fireBeforeQuit();
    assert.equal(event.prevented, true);
    assert.equal(harness.sent.filter((channel) => channel === "app-closing").length, 1);
    assert.equal(harness.quitCalls.length, 0);

    const saved = await harness.save('{"students":[]}');
    assert.equal(saved.ok, true);
    assert.deepEqual(harness.storeMock.saved, ['{"students":[]}']);

    const repeated = harness.fireBeforeQuit();
    assert.equal(repeated.prevented, true);
    assert.equal(harness.sent.filter((channel) => channel === "app-closing").length, 1);

    harness.closeReady();
    await harness.ready();
    assert.equal(harness.quitCalls.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("a save failure during close is logged and does not prevent shutdown", async () => {
  const message = "تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.";
  const harness = loadMain({
    save() {
      return { ok: false, code: "WRITE_FAILED", error: message };
    },
  });
  try {
    await harness.ready();

    harness.fireClose();
    const saved = await harness.save('{"students":[]}');
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "WRITE_FAILED");
    assert.ok(harness.errors.some((entry) => entry.includes(message)));

    harness.closeReady();
    await harness.ready();
    assert.equal(harness.window.isDestroyed(), true);
  } finally {
    harness.cleanup();
  }
});

test("a renderer that never acknowledges close still times out and closes safely", async () => {
  const harness = loadMain();
  try {
    await harness.ready();

    harness.fireClose();
    assert.equal(harness.window.isDestroyed(), false);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(harness.window.isDestroyed(), true);
  } finally {
    harness.cleanup();
  }
});
