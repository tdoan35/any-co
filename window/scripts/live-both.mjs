// Launch the studio window with both studios switchable (desktop brief, goal 1):
//   studio 1 — this Mac's live adapter (default 8787, PORT to change)
//   studio 2 — the read-only mirror adapter on 8790 (the EA's), or our own on a spare port
// Adapters already listening are reused, never killed or duplicated. Only processes this
// script spawns are stopped on exit.
//   node scripts/live-both.mjs          -> adapters + Vite dev server (browser)
//   node scripts/live-both.mjs electron -> adapters + Electron window
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const winDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(winDir, "..");
const electron = process.argv[2] === "electron";
const s1Port = Number(process.env.PORT) || 8787;
const s2EaPort = 8790; // the EA's mirror adapter — reused as-is
const mirrorDir = path.join(os.homedir(), "Desktop/projects/anyco-studio2-mirror");

const probe = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
};

const waitFor = async (port, label, seconds = 30) => {
  for (let left = seconds * 1000 / 300; left > 0; left--) {
    if (await probe(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`[live-both] ${label} adapter on ${port} did not come up`);
};

const started = [];
const spawnAdapter = (port, env, label) => {
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "window/server/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "inherit",
  });
  started.push(child);
  console.log(`[live-both] ${label} adapter starting on http://127.0.0.1:${port} (pid ${child.pid})`);
  return child;
};

const stop = () => { for (const child of started) child.kill(); };
process.on("SIGINT", () => { stop(); process.exit(130); });
process.on("SIGTERM", () => { stop(); process.exit(143); });

// Studio 2: reuse the EA's read-only mirror adapter if it is up, else run our own against
// the same mirror dirs (read-only; the mirror is rsync'd with --delete, writes would be lost).
let s2Port = s2EaPort;
if (await probe(s2EaPort)) {
  console.log(`[live-both] reusing the studio 2 mirror adapter on http://127.0.0.1:${s2EaPort}`);
} else {
  s2Port = 8792;
  while (s2Port < 8800 && await probe(s2Port)) s2Port++; // first port with nothing on it
  if (s2Port >= 8800) throw new Error("[live-both] no free port between 8792 and 8799 for the studio 2 adapter");
  spawnAdapter(s2Port, {
    STUDIO_RUNS_DIR: path.join(mirrorDir, "runs"),
    STUDIO_GAMES_DIR: path.join(mirrorDir, "games"),
    STUDIO_WINDOW_READONLY: "1",
  }, "studio 2 (own mirror, read-only)");
  await waitFor(s2Port, "studio 2");
}

// Studio 1: this Mac's live adapter; reuse one that is already running (e.g. the EA's).
if (!(await probe(s1Port))) {
  spawnAdapter(s1Port, {}, "studio 1");
  await waitFor(s1Port, "studio 1");
} else {
  console.log(`[live-both] reusing the studio 1 adapter on http://127.0.0.1:${s1Port}`);
}

const studios = [
  { id: "s1", label: "Studio 1", api: `http://127.0.0.1:${s1Port}` },
  { id: "s2", label: "Studio 2", api: `http://127.0.0.1:${s2Port}`, readOnly: true },
];
const uiEnv = { ...process.env, VITE_API_MODE: "http", VITE_API_URL: studios[0].api, VITE_STUDIOS: JSON.stringify(studios) };
const ui = electron
  ? spawn(process.execPath, ["scripts/electron-dev.mjs"], { cwd: winDir, env: uiEnv, stdio: "inherit" })
  : spawn("npx", ["vite"], { cwd: winDir, env: uiEnv, stdio: "inherit" });
console.log(`[live-both] window starting: studio 1 ${studios[0].api}, studio 2 ${studios[1].api} (read-only)`);
ui.on("exit", (code) => { stop(); process.exit(code ?? 0); });
