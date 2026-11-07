// Reap detached process groups when their owner dies (review R16-3). Tools that spawn a game or a
// build in its own process group (media_capture, game_exec) kill the group on every normal exit
// path, but if the runner itself exits, is signalled, or is SIGKILLed, the group used to keep
// running with PPID 1. track(pid) registers a live group:
//   - process "exit" and SIGINT/SIGTERM/SIGHUP: SIGKILL every tracked group (then the signal's
//     default action still happens when nobody else handles it);
//   - kill -9 of the runner (no handler can run): a tiny detached watchdog polls the owner's pid
//     and kills the group when the owner is gone; it exits on its own once the group is gone.
import { spawn } from "node:child_process";

const live = new Set<number>();
let installed = false;

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    // group already gone
  }
}

function install() {
  if (installed) return;
  installed = true;
  process.on("exit", () => {
    for (const pid of live) killGroup(pid, "SIGKILL");
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      for (const pid of live) killGroup(pid, "SIGKILL");
      live.clear();
      // Only we listened: restore the default action (terminate) by re-raising.
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, onSignal);
  }
}

// Watchdog body (plain JS, no imports beyond process): argv = [ownerPid, groupPid, pollMs].
const WATCHDOG = `
const [owner, group, poll] = process.argv.slice(1).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const groupAlive = () => { try { process.kill(-group, 0); return true; } catch (e) { return e.code === "EPERM"; } };
setInterval(() => {
  if (!groupAlive()) process.exit(0);
  if (!alive(owner)) {
    try { process.kill(-group, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-group, "SIGKILL"); } catch {} process.exit(0); }, 1500);
  }
}, poll);
`;

export interface Tracked { untrack(): void; watchdogPid: number | null }

/** Register a live process group (the pid of a `detached: true` child). Call untrack() once it is reaped. */
export function track(pid: number, opts: { watchdog?: boolean; pollMs?: number } = {}): Tracked {
  install();
  live.add(pid);
  let dog: ReturnType<typeof spawn> | null = null;
  if (opts.watchdog !== false) {
    dog = spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), String(pid), String(opts.pollMs ?? 500)], { detached: true, stdio: "ignore" });
    dog.on("error", () => {}); // best effort: the exit/signal handlers still cover the common cases
    dog.unref();
  }
  return {
    watchdogPid: dog?.pid ?? null,
    untrack() {
      live.delete(pid);
      if (dog?.pid) killGroup(dog.pid, "SIGKILL");
    },
  };
}

/** For tests: groups currently tracked. */
export const trackedGroups = () => [...live];
