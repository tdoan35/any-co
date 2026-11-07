// Start the Vite dev server, then launch Electron against it (with HMR).
// Quitting Electron stops the dev server.
import { spawn } from "node:child_process";
import electron from "electron";
import { createServer } from "vite";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("Vite dev server did not report a local URL");

// Extra CLI args (e.g. --remote-debugging-port=9222) pass through to Electron.
const child = spawn(electron, [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, FABRIC_DEV_URL: url },
});
child.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
