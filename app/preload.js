// 渲染进程只能通过这层拿到能力；不开 nodeIntegration，不暴露 ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocv", {
  config: () => ipcRenderer.invoke("ocv:config"),
  save: (cfg) => ipcRenderer.invoke("ocv:save", cfg),
  state: () => ipcRenderer.invoke("ocv:state"),
  run: (args) => ipcRenderer.invoke("ocv:run", args),
  cancel: () => ipcRenderer.invoke("ocv:cancel"),
  open: (what) => ipcRenderer.invoke("ocv:open", what),
  pickFolder: () => ipcRenderer.invoke("ocv:pick-folder"),
  checkEnv: () => ipcRenderer.invoke("ocv:check-env"),
  ocrInstall: () => ipcRenderer.invoke("ocv:ocr-install"),
  ocrCheck: () => ipcRenderer.invoke("ocv:ocr-check"),
  keepAwake: (on) => ipcRenderer.invoke("ocv:keep-awake", on),
  branches: (repoPath) => ipcRenderer.invoke("ocv:branches", repoPath),
  updateCheck: () => ipcRenderer.invoke("ocv:update-check"),
  onOutput: (cb) => ipcRenderer.on("ocv:out", (_e, text) => cb(text)),
  onDone: (cb) => ipcRenderer.on("ocv:done", (_e, code) => cb(code)),
});
