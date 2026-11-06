const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", Object.freeze({
  load: () => ipcRenderer.invoke("load"),
  save: (json) => ipcRenderer.invoke("save", json),
  listBackups: () => ipcRenderer.invoke("list-backups"),
  restoreBackup: (name) => ipcRenderer.invoke("restore-backup", name),
  restoreImportedData: (json) => ipcRenderer.invoke("restore-imported-data", json),
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
  onClosing: (handler) => ipcRenderer.on("app-closing", () => handler()),
  closeReady: () => ipcRenderer.send("close-ready"),
}));
