// Sandboxed preloads must be CommonJS. Keep this surface small; anything the
// renderer needs from the desktop side gets an explicit entry here (typed in
// src/lib/desktop.ts).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fabricDesktop", {
  platform: process.platform,
  app: {
    command: (command) => ipcRenderer.send("app:command", command),
    /** Current zoom factor and its bounds. Sent after any pending command, so it reflects it. */
    zoom: () => ipcRenderer.invoke("app:zoom"),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    /** Returns an unsubscribe function. */
    onMaximizedChange: (cb) => {
      const listener = (_e, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized", listener);
      return () => ipcRenderer.removeListener("window:maximized", listener);
    },
  },
});
