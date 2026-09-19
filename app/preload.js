// 渲染进程只能通过这层拿到能力；不开 nodeIntegration，不暴露 ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocv", {
  config: () => ipcRenderer.invoke("ocv:config"),
  save: (cfg) => ipcRenderer.invoke("ocv:save", cfg),
  state: () => ipcRenderer.invoke("ocv:state"),
  run: (args) => ipcRenderer.invoke("ocv:run", args),
  cancel: () => ipcRenderer.invoke("ocv:cancel"),
  open: (what) => ipcRenderer.invoke("ocv:open", what),
  onOutput: (cb) => ipcRenderer.on("ocv:out", (_e, text) => cb(text)),
  onDone: (cb) => ipcRenderer.on("ocv:done", (_e, code) => cb(code)),
});