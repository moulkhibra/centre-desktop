const { app, BrowserWindow, ipcMain, shell, Menu, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { createStore } = require("./data-store");
const { validateData, MAX_JSON_BYTES } = require("./data-validation");
const { isAllowedExternalUrl, isAppFileUrl, isTrustedIpcEvent, isOneDrivePath } = require("./security");
const { createSaveQueue } = require("./save-queue");
const { createShutdownCoordinator } = require("./shutdown-coordinator");
const { shouldShowOneDriveWarning, markOneDriveWarningShown } = require("./onedrive-warning");
const { resolveTestIsolation } = require("./runtime-paths");
const { verifyStartupLicense } = require("./startup-license");

let startupConfigError = null;
let isolatedRuntime = null;
try {
  if (!app.isPackaged) {
    const hasTestData = Object.prototype.hasOwnProperty.call(process.env, "CENTRE_TEST_DATA_DIR");
    const hasTestProfile = Object.prototype.hasOwnProperty.call(process.env, "CENTRE_TEST_PROFILE");
    if (hasTestData || hasTestProfile) {
      isolatedRuntime = resolveTestIsolation({
        isPackaged: false,
        env: process.env,
        productionDataDir: path.join(app.getPath("documents"), "CentreData"),
        productionUserDataDir: app.getPath("userData"),
      });
      if (isolatedRuntime.profileDir) app.setPath("userData", isolatedRuntime.profileDir);
    }
  }
} catch (error) {
  startupConfigError = error;
}

const hasSingleInstanceLock = startupConfigError ? false : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock && !startupConfigError) app.quit();

const APP_INDEX = path.join(__dirname, "index.html");
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const DRAIN_TIMEOUT_MS = 10000;

let store = null;
let dataDir = "";
let mainWindow = null;
let saveQueue = null;
let closePending = false;
let closeAcked = false;
let closeAckResolve = null;
let quitBypass = false;
let shutdownCoordinator = null;

function trusted(event) {
  return isTrustedIpcEvent(event, mainWindow, APP_INDEX);
}

function untrusted() {
  return { ok: false, code: "UNTRUSTED", error: "طلب غير موثوق." };
}

function closingResult() {
  return { ok: false, code: "CLOSING", error: "التطبيق قيد الإغلاق. لم يتم حفظ أي تغيير." };
}

const ACTIVATION_ERROR_MESSAGES = Object.freeze({
  PRODUCTION_KEY_NOT_CONFIGURED:
    "لم يتم إعداد مفتاح الترخيص في هذا الإصدار. لا يمكن تشغيل التطبيق. تواصل مع الدعم للحصول على نسخة صالحة.",
  LICENSE_MISSING:
    "لا يوجد ترخيص مفعّل على هذا الحاسوب. فعّل التطبيق ثم أعد تشغيله.",
  LICENSE_UNREADABLE:
    "تعذر قراءة ملف الترخيص. تحقق من إعدادات التطبيق أو تواصل مع الدعم.",
  LICENSE_TOO_LARGE:
    "ملف الترخيص غير صالح لأن حجمه كبير جدا. تواصل مع الدعم.",
  LICENSE_INVALID:
    "الترخيص غير صالح أو غير موثوق. تواصل مع الدعم للحصول على ترخيص صحيح.",
  DEVICE_MISMATCH:
    "هذا الترخيص مخصص لحاسوب آخر ولا يمكن استخدامه على هذا الحاسوب.",
  DEVICE_REQUIRED:
    "الترخيص غير مرتبط بحاسوب. تواصل مع الدعم للحصول على ترخيص صالح.",
  IDENTIFIER_UNAVAILABLE:
    "تعذر التحقق من هوية هذا الحاسوب. أعد تشغيل التطبيق أو تواصل مع الدعم.",
  MALFORMED_DEVICE_BINDING:
    "بيانات ربط الترخيص بالحاسوب غير صالحة. تواصل مع الدعم.",
  MALFORMED_IDENTIFIERS:
    "بيانات هوية الحاسوب غير صالحة. تواصل مع الدعم.",
  UNSUPPORTED_PLATFORM:
    "التحقق من الترخيص مدعوم على Windows فقط.",
  UNSAFE_LICENSE_STORAGE:
    "موقع تخزين الترخيص غير آمن. تواصل مع الدعم.",
  INVALID_OPTIONS:
    "إعداد الترخيص غير صالح. تواصل مع الدعم.",
  LICENSE_GATE_FAILED:
    "تعذر إكمال التحقق من الترخيص. أعد تشغيل التطبيق أو تواصل مع الدعم.",
});

function activationFailureMessage(result) {
  if (
    result &&
    result.code === "LICENSE_INVALID" &&
    result.cause === "NOT_YET_VALID"
  ) {
    return "الترخيص غير ساري بعد. تحقق من تاريخ بدء الصلاحية أو تواصل مع الدعم.";
  }
  const message = result && ACTIVATION_ERROR_MESSAGES[result.code];
  return message || ACTIVATION_ERROR_MESSAGES.LICENSE_INVALID;
}

function showActivationFailure(result) {
  dialog.showErrorBox(
    "تعذر تفعيل Centre",
    activationFailureMessage(result) +
      "\n\nلم يتم فتح مجلد المعطيات ولم يتم تعديل أي معطيات."
  );
}

function requestRendererClose() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  return new Promise(function (resolve) {
    let done = false;
    let timer = null;
    function finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (closeAckResolve === finish) closeAckResolve = null;
      resolve();
    }
    closeAckResolve = finish;
    try {
      mainWindow.webContents.send("app-closing");
    } catch (error) {
      finish();
      return;
    }
    timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
  });
}

function beginShutdown() {
  if (!shutdownCoordinator && saveQueue) {
    shutdownCoordinator = createShutdownCoordinator({
      queue: saveQueue,
      requestRendererFlush: requestRendererClose,
      timeoutMs: DRAIN_TIMEOUT_MS,
      onFailure: function (result) {
        quitBypass = true;
        console.error((result && result.error) || "انتهت مهلة انتظار حفظ التغييرات. سيتم إغلاق التطبيق.");
      },
    });
  }
  return shutdownCoordinator.start();
}

function finishWindowClose() {
  closePending = false;
  closeAcked = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

function registerIpc() {
  ipcMain.on("close-ready", (event) => {
    if (!trusted(event)) return;
    const finish = closeAckResolve;
    closeAckResolve = null;
    if (finish) finish();
  });

  ipcMain.handle("load", (event) => {
    if (!trusted(event)) return untrusted();
    try {
      return store.load();
    } catch (error) {
      return { ok: false, code: "LOAD_FAILED", error: "تعذر تحميل المعطيات. لم يتم تعديل الملف." };
    }
  });

  ipcMain.handle("save", (event, json) => {
    if (!trusted(event)) return untrusted();
    return saveQueue.enqueue(json);
  });

  ipcMain.handle("list-backups", (event) => {
    if (!trusted(event)) return untrusted();
    try {
      return store.listBackups();
    } catch (error) {
      return { ok: false, code: "BACKUP_LIST_FAILED", error: "تعذر قراءة النسخ الاحتياطية." };
    }
  });

  ipcMain.handle("restore-backup", async (event, name) => {
    if (!trusted(event)) return untrusted();
    if (saveQueue.isClosing()) return closingResult();
    const listed = store.listBackups();
    if (!listed.ok) return listed;
    const found = listed.backups.find((item) => item.name === name);
    if (!found) {
      return { ok: false, code: "BACKUP_NOT_FOUND", error: "النسخة الاحتياطية غير موجودة." };
    }
    if (!found.valid) {
      return { ok: false, code: "INVALID_BACKUP", error: "النسخة الاحتياطية غير صالحة ولا يمكن استرجاعها." };
    }
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "تأكيد استرجاع نسخة احتياطية",
      message: "هل تريد استرجاع هذه النسخة الاحتياطية؟",
      detail: found.name + "\nسيتم إنشاء نسخة من المعطيات الحالية قبل الاستبدال.",
      buttons: ["إلغاء", "استرجاع"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) {
      return { ok: false, code: "CANCELLED", error: "تم إلغاء الاسترجاع." };
    }
    return saveQueue.run(function () {
      try {
        return store.restoreBackup(name);
      } catch (error) {
        return { ok: false, code: "RESTORE_FAILED", error: "تعذر استرجاع النسخة الاحتياطية. لم يتم تعديل الملف الحالي." };
      }
    });
  });

  ipcMain.handle("restore-imported-data", async (event, json) => {
    if (!trusted(event)) return untrusted();
    if (saveQueue.isClosing()) return closingResult();
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
      return { ok: false, code: "INVALID_INPUT", error: "حجم البيانات كبير جدا." };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return { ok: false, code: "INVALID_JSON", error: "الملف المستورد ليس JSON صالحا." };
    }
    const checked = validateData(parsed, { mode: "import" });
    if (!checked.ok) return { ok: false, code: "INVALID_DATA", error: checked.error };
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "تأكيد استيراد نسخة",
      message: "هل تريد استبدال المعطيات الحالية بهذه النسخة؟",
      detail: checked.data.students.length + " تلميذ، " + checked.data.regs.length + " تسجيل، " +
        checked.data.pays.length + " أداء.\nسيتم إنشاء نسخة من المعطيات الحالية قبل الاستبدال.",
      buttons: ["إلغاء", "استبدال"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) {
      return { ok: false, code: "CANCELLED", error: "تم إلغاء الاستيراد." };
    }
    return saveQueue.run(function () {
      try {
        return store.restoreImportedData(json);
      } catch (error) {
        return { ok: false, code: "RESTORE_FAILED", error: "تعذر استيراد النسخة. لم يتم تعديل الملف الحالي." };
      }
    });
  });

  ipcMain.handle("open-data-folder", async (event) => {
    if (!trusted(event)) return untrusted();
    try {
      const target = path.join(dataDir, "data.json");
      if (fs.existsSync(target)) {
        shell.showItemInFolder(target);
      } else {
        const message = await shell.openPath(dataDir);
        if (message) throw new Error(message);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "OPEN_FOLDER_FAILED", error: "تعذر فتح مجلد البيانات." };
    }
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile(APP_INDEX).catch(function () {
    dialog.showErrorBox(
      "تعذر تحميل الواجهة",
      "تعذر تحميل واجهة التطبيق. أعد تشغيل التطبيق أو أعد تثبيته."
    );
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppFileUrl(url, APP_INDEX)) event.preventDefault();
  });

  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAppFileUrl(url, APP_INDEX)) event.preventDefault();
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    if (!saveQueue || closeAcked) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    beginShutdown().then(finishWindowClose, () => {
      quitBypass = true;
      console.error("تعذر انتظار حفظ التغييرات. سيتم إغلاق التطبيق.");
      finishWindowClose();
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("web-contents-created", (event, contents) => {
  contents.on("will-attach-webview", (webviewEvent) => {
    webviewEvent.preventDefault();
  });
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (startupConfigError) {
    dialog.showErrorBox(
      "تعذر تشغيل وضع الاختبار",
      String(startupConfigError.message || startupConfigError) + "\n\nلم يتم تعديل أي معطيات."
    );
    app.quit();
    return;
  }
  if (!hasSingleInstanceLock) return;

  try {
    dataDir = isolatedRuntime
      ? isolatedRuntime.dataDir
      : path.join(app.getPath("documents"), "CentreData");
  } catch (error) {
    dialog.showErrorBox(
      "تعذر فتح مجلد البيانات",
      "تعذر الوصول إلى مجلد Documents/CentreData. لم يتم تعديل أي معطيات.\n\n" + String(error && error.message ? error.message : error)
    );
    app.quit();
    return;
  }

  let licenseResult;
  try {
    licenseResult = await verifyStartupLicense({
      dataDir: dataDir,
      userDataDir: app.getPath("userData"),
    });
  } catch (error) {
    licenseResult = {
      ok: false,
      code: "LICENSE_GATE_FAILED",
      error: "License verification could not be completed.",
    };
  }

  if (!licenseResult || licenseResult.ok !== true) {
    showActivationFailure(licenseResult);
    app.quit();
    return;
  }

  try {
    store = createStore({ dir: dataDir });
    saveQueue = createSaveQueue(function (json) {
      return Promise.resolve(store.save(json)).then(
        function (result) {
          if (shutdownCoordinator && (!result || !result.ok)) {
            console.error((result && result.error) || "تعذر حفظ التغييرات أثناء الإغلاق.");
          }
          return result;
        },
        function (error) {
          if (shutdownCoordinator) console.error("تعذر حفظ التغييرات أثناء الإغلاق.");
          throw error;
        }
      );
    });
    store.ensureDir();
  } catch (error) {
    dialog.showErrorBox(
      "تعذر فتح مجلد البيانات",
      "تعذر الوصول إلى مجلد Documents/CentreData. لم يتم تعديل أي معطيات.\n\n" + String(error && error.message ? error.message : error)
    );
    app.quit();
    return;
  }

  registerIpc();

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);
    headers["Content-Security-Policy"] = [CSP];
    callback({ responseHeaders: headers });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  createWindow();

  if (isOneDrivePath(dataDir)) {
    const userDataDir = app.getPath("userData");
    if (shouldShowOneDriveWarning(userDataDir)) {
      markOneDriveWarningShown(userDataDir);
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "تنبيه حول مجلد البيانات",
        message: "مجلد Documents كيبان أنه متزامن مع OneDrive.",
        detail: "المعطيات كتوجد فـ Documents/CentreData. OneDrive يقدر يزامن الملف أثناء الاستعمال ويسبب تعارض أو ضياع التعديلات. التطبيق غادي يستمر فالحفظ بنفس المكان.",
        buttons: ["فهمت"],
        noLink: true,
      }).catch(() => {});
    }
  }
}).catch((error) => {
  dialog.showErrorBox(
    "تعذر تشغيل التطبيق",
    "حدث خطأ أثناء بدء التطبيق. لم يتم تعديل أي معطيات.\n\n" + String(error && error.message ? error.message : error)
  );
  app.quit();
});

let quitPending = false;
app.on("before-quit", (event) => {
  if (!saveQueue) return;
  if (quitBypass || closeAcked) return;
  if (quitPending) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  quitPending = true;
  beginShutdown().then(() => {
    quitPending = false;
    closeAcked = true;
    app.quit();
  }, () => {
    quitBypass = true;
    console.error("تعذر انتظار حفظ التغييرات. سيتم إغلاق التطبيق.");
    quitPending = false;
    closeAcked = true;
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
