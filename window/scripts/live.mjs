// Run the studio window against live data: the read-only adapter plus the UI in http mode.
//   node scripts/live.mjs          -> adapter + Vite dev server (browser)
//   node scripts/live.mjs electron -> adapter + Electron window
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const winDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(winDir, "..");
const port = process.env.PORT || "8787";
const env = { ...process.env, PORT: port, VITE_API_MODE: "http", VITE_API_URL: `http://127.0.0.1:${port}` };

const server = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "window/server/index.ts"], { cwd: root, env, stdio: "inherit" });
const ui = process.argv[2] === "electron"
  ? spawn(process.execPath, ["scripts/electron-dev.mjs"], { cwd: winDir, env, stdio: "inherit" })
  : spawn("npx", ["vite"], { cwd: winDir, env, stdio: "inherit" });

const stop = () => { server.kill(); ui.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
server.on("exit", (c) => { if (c) { console.error("[window] adapter exited"); ui.kill(); process.exit(c); } });
ui.on("exit", (c) => { server.kill(); process.exit(c ?? 0); });
