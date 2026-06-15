const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("watch", {
  getConversation() {
    return ipcRenderer.invoke("watch:getConversation");
  },
  getStatus() {
    return ipcRenderer.invoke("watch:getStatus");
  },
  setVisualizationEnabled(enabled) {
    return ipcRenderer.invoke("watch:setVisualizationEnabled", { enabled });
  },
  send(message) {
    return ipcRenderer.invoke("watch:send", { message });
  },
  sendWithScreenshot(message) {
    return ipcRenderer.invoke("watch:sendWithScreenshot", { message });
  },
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("watch:event", listener);
    return () => ipcRenderer.off("watch:event", listener);
  },
  onVisualizationEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("watch:visualization-event", listener);
    return () => ipcRenderer.off("watch:visualization-event", listener);
  },
});
