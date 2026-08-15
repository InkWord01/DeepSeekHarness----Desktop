// DeepSeek Harness Desktop - preload
// 只暴露只读信息，不开放 Node 能力（沙箱 + contextIsolation）
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  getInfo: () => ipcRenderer.invoke("app-info"),
  onBackendStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("backend-status", handler);
    return () => ipcRenderer.removeListener("backend-status", handler);
  }
});
