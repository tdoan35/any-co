// Electron shell for the any-co studio window. It loads the same Vite build that
// ships to the web: in dev from the Vite server (FABRIC_DEV_URL), otherwise
// from dist/ over a custom app:// protocol so root-absolute asset paths and
// BrowserRouter URLs resolve exactly as they do on a web server.
import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST = path.join(import.meta.dirname, "..", "dist");
const DEV_URL = process.env.FABRIC_DEV_URL;
const APP_ORIGIN = "app://fabric";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveDist() {
  protocol.handle("app", async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.join(DIST, decodeURIComponent(pathname));
    // Refuse anything that escapes dist/.
    if (!file.startsWith(DIST)) return new Response(null, { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (res?.ok) return res;
    // SPA fallback: unknown paths are client routes.
    return net.fetch(pathToFileURL(path.join(DIST, "index.html")).toString());
  });
}

// The renderer draws its own title bar (src/components/shell/title-bar.tsx). On macOS the native
// traffic lights stay, inset into it; elsewhere the window is frameless and the bar draws the controls.
const chrome = process.platform === "darwin"
  ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 9 } }
  : { frame: false };

// Chrome's zoom presets, so the level always reads as a round percentage.
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// Small desktop-only preferences (currently just zoom), in the per-user app data folder.
const prefsFile = () => path.join(app.getPath("userData"), "preferences.json");

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch { return {}; }
}

function writePrefs(patch) {
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2)); } catch (err) { console.error("Couldn't save preferences:", err); }
}

function savedZoom() {
  const z = readPrefs().zoomFactor;
  return typeof z === "number" && z >= ZOOM_STEPS[0] && z <= ZOOM_STEPS.at(-1) ? z : 1;
}

function setZoom(wc, factor) {
  wc.setZoomFactor(factor);
  writePrefs({ zoomFactor: factor });
}

function stepZoom(wc, dir) {
  const f = wc.getZoomFactor();
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > f + 0.001) : ZOOM_STEPS.findLast((s) => s < f - 0.001);
  if (next) setZoom(wc, next);
}

function windowControls() {
  const from = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on("window:minimize", (e) => from(e)?.minimize());
  ipcMain.on("window:toggle-maximize", (e) => {
    const win = from(e);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on("window:close", (e) => from(e)?.close());
  ipcMain.handle("app:zoom", (e) => ({ factor: e.sender.getZoomFactor(), min: ZOOM_STEPS[0], max: ZOOM_STEPS.at(-1) }));
  ipcMain.handle("window:is-maximized", (e) => from(e)?.isMaximized() ?? false);

  // App menu commands from the title bar's hamburger menu. Unknown commands are ignored.
  ipcMain.on("app:command", (e, command) => {
    const wc = e.sender;
    const win = from(e);
    switch (command) {
      case "reload": return wc.reload();
      case "zoom-in": return stepZoom(wc, 1);
      case "zoom-out": return stepZoom(wc, -1);
      case "zoom-reset": return setZoom(wc, 1);
      case "toggle-fullscreen": return win?.setFullScreen(!win.isFullScreen());
      case "toggle-devtools": return wc.toggleDevTools();
      case "quit": return app.quit();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    ...chrome,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "any-co game studio",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Restored here, not after load, so the first frame is already at the saved size.
      zoomFactor: savedZoom(),
    },
  });

  // Compare protocol+host: URL.origin is "null" for custom schemes like app://.
  const home = new URL(DEV_URL ?? APP_ORIGIN);
  const isInternal = (url) => {
    const u = new URL(url);
    return u.protocol === home.protocol && u.host === home.host;
  };
  // New-window links (target="_blank") and off-origin navigation go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isInternal(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  for (const ev of ["maximize", "unmaximize"]) {
    win.on(ev, () => win.webContents.send("window:maximized", win.isMaximized()));
  }

  // Also catches zoom changed outside our commands (e.g. the default menu's Ctrl+= accelerators).
  win.on("close", () => writePrefs({ zoomFactor: win.webContents.getZoomFactor() }));

  win.once("ready-to-show", () => win.show());
  win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
}

app.whenReady().then(() => {
  if (!DEV_URL) serveDist();
  windowControls();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
