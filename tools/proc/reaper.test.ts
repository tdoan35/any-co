import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function gone(pid: number, withinMs: number) {
  for (const t0 = Date.now(); Date.now() - t0 < withinMs; await sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

/** An "owner" process (like the runner) that starts a detached long-lived group, tracks it, then dies `how`.
 *  Only the kill -9 case runs the watchdog, so the exit/signal cases prove the in-process handlers. */
async function owner(how: "exit" | "SIGTERM" | "SIGINT" | "kill9"): Promise<{ child: number; owner: number }> {
  const dir = mkdtempSync(path.join(tmpdir(), "reaper-"));
  const script = path.join(dir, "owner.ts");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { track } from ${JSON.stringify(path.join(HERE, "reaper.ts"))};
const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], { detached: true, stdio: "ignore" });
track(c.pid!, { pollMs: 100, watchdog: !process.env.NO_WATCHDOG });
console.log(c.pid);
if (process.env.OWNER_EXIT) setTimeout(() => process.exit(0), 300);
setInterval(() => {}, 1000);
`,
  );
  const p = spawn(process.execPath, ["--import", "tsx", script], { cwd: REPO, env: { ...process.env, ...(how === "exit" ? { OWNER_EXIT: "1" } : {}), ...(how === "kill9" ? {} : { NO_WATCHDOG: "1" }) }, stdio: ["ignore", "pipe", "inherit"] });
  const child = await new Promise<number>((resolve) => p.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
  if (how !== "exit") await sleep(200); // the watchdog is up
  assert.ok(alive(child));
  if (how === "kill9") p.kill("SIGKILL");
  else if (how !== "exit") p.kill(how); // "exit": the owner calls process.exit itself
  return { child, owner: p.pid! };
}

for (const how of ["exit", "SIGTERM", "SIGINT"] as const)
  test(`a tracked group dies when its owner ${how === "exit" ? "calls process.exit" : `gets ${how}`} (and the owner still terminates)`, async () => {
    const { child, owner: o } = await owner(how);
    assert.ok(await gone(child, 3000), "the game group was reaped");
    assert.ok(await gone(o, 3000), "the owner still terminated (default action restored)");
  });

test("a tracked group dies when its owner is SIGKILLed (watchdog)", async () => {
  const { child } = await owner("kill9");
  assert.ok(await gone(child, 4000), "the watchdog reaped the orphaned group");
});

test("untrack stops the watchdog; process exit reaps what is still tracked", async () => {
  const { track, trackedGroups } = await import("./reaper.ts");
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { detached: true, stdio: "ignore" });
  const t = track(c.pid!, { pollMs: 100, watchdog: !process.env.NO_WATCHDOG });
  assert.ok(trackedGroups().includes(c.pid!));
  assert.ok(t.watchdogPid && alive(t.watchdogPid));
  t.untrack();
  assert.ok(!trackedGroups().includes(c.pid!));
  assert.ok(await gone(t.watchdogPid!, 2000));
  process.kill(-c.pid!, "SIGKILL");
});
