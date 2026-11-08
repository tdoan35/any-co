// Capture stills or footage from a running game through docs/contracts only: launch flags
// (controls.md), the autoplay policy (autoplay.md), the qa/ protocol (screenshot, step, pause,
// dump_state, quit) and events.jsonl (events.md). Nothing here knows a specific game.
//
//   ticks:  pause, step to each listed tick, screenshot (exact frames for a trailer storyboard)
//   events: run free; on a matching event pause → dump_state → screenshot → resume
//   movie:  engine movie mode (Godot `--write-movie <file>`, docs/decisions.md engine spike)
//           with `--exit-after-ticks N`, for continuous footage
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { decodePng } from "../art/png.ts";
import { QaClient } from "./protocol.ts";
import { track } from "../proc/reaper.ts";

export type CaptureMode =
  | { kind: "ticks"; ticks: number[] }
  | { kind: "events"; triggers: Array<{ event: string; every?: number; max?: number }>; max_shots: number }
  | { kind: "movie"; file: string; exit_after_ticks: number };

export interface CaptureOptions {
  gameDir: string; // the game clone: process cwd and the root qa/ lives under
  launch: string[]; // argv prefix that starts the desktop build, e.g. ["godot", "--path", "."]
  separator?: string; // put between engine args and contract flags, e.g. "--" (Godot user args)
  seed: number;
  timeScale: number;
  policy: string; // "random" | "greedy" | "script:PATH" (autoplay.md)
  resolution: { w: number; h: number };
  outDir: string; // absolute; stills are copied here
  mode: CaptureMode;
  timeoutMs: number;
  graceMs?: number; // after quit (or the movie's exit), how long before SIGTERM, then SIGKILL
  pollMs?: number;
  env?: Record<string, string | undefined>;
  /** The env the game starts from (default process.env); the runner passes a scrubbed one (T40). */
  baseEnv?: Record<string, string | undefined>;
}

export interface Shot { file: string; tick: number; trigger: string }
export interface CaptureResult {
  argv: string[];
  shots: Shot[];
  movie?: { file: string; bytes: number };
  exit: { code: number | null; signal: string | null; killed: boolean };
  events_seen: number;
  notes: string[];
  stderr_tail: string;
}

export const POLICY = /^(random|greedy|script:.+)$/;

/** The launch argv: prefix, engine args (movie), separator, then the contract flags. */
export function launchArgv(o: Pick<CaptureOptions, "launch" | "separator" | "seed" | "timeScale" | "policy" | "resolution" | "mode">): string[] {
  if (o.launch.length === 0) throw new Error("launch must name the desktop build to run");
  if (!POLICY.test(o.policy)) throw new Error(`policy must be random, greedy, or script:PATH (got "${o.policy}")`);
  if (!(o.timeScale >= 0.1 && o.timeScale <= 20)) throw new Error(`time_scale must be 0.1–20 (controls.md), got ${o.timeScale}`);
  const engine = o.mode.kind === "movie" ? ["--write-movie", o.mode.file] : [];
  const flags = [
    "--qa", "--seed", String(o.seed), "--time-scale", String(o.timeScale), "--autoplay", "--policy", o.policy,
    "--resolution", `${o.resolution.w}x${o.resolution.h}`,
    ...(o.mode.kind === "movie" ? ["--exit-after-ticks", String(o.mode.exit_after_ticks)] : []),
  ];
  return [...o.launch, ...engine, ...(o.separator ? [o.separator] : []), ...flags];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kill the game's whole process group (engines spawn helpers): SIGTERM, then SIGKILL. */
async function stop(child: ChildProcess, exited: () => boolean, graceMs: number): Promise<boolean> {
  if (exited()) return false;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      child.kill(sig);
    }
  };
  signal("SIGTERM");
  for (const t0 = Date.now(); !exited() && Date.now() - t0 < graceMs; ) await sleep(10);
  if (!exited()) signal("SIGKILL");
  for (const t0 = Date.now(); !exited() && Date.now() - t0 < 2000; ) await sleep(10);
  return true;
}

export async function capture(o: CaptureOptions): Promise<CaptureResult> {
  const argv = launchArgv(o);
  const graceMs = o.graceMs ?? 3000;
  const deadline = Date.now() + o.timeoutMs;
  mkdirSync(o.outDir, { recursive: true });
  if (o.mode.kind === "movie") mkdirSync(path.dirname(o.mode.file), { recursive: true });

  // Stale handshake files from an earlier run must not pass for this game's ready ack.
  const qa = new QaClient(o.gameDir, o.pollMs ?? 5, () => !exited());
  qa.clearHandshake();
  const spawnedAt = Date.now() - 1; // mtime granularity slack; the files were just removed anyway
  const child = spawn(argv[0], argv.slice(1), { cwd: o.gameDir, env: { ...(o.baseEnv ?? process.env), ...o.env }, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  // if the runner exits, is signalled, or is SIGKILLed mid-capture, the game's group goes with it
  const reaper = child.pid ? track(child.pid) : null;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  child.once("exit", (code, signal) => (exitInfo = { code, signal }));
  // a spawn failure (ENOENT, EACCES) never emits "exit": count it as exited so nothing waits on it
  const spawnError = new Promise<never>((_, reject) =>
    child.once("error", (e) => {
      exitInfo ??= { code: null, signal: null };
      reject(new Error(`could not start the game (${argv[0]}): ${e.message}`));
    }),
  );
  spawnError.catch(() => {});
  const exited = () => exitInfo !== null;

  const shots: Shot[] = [];
  const notes: string[] = [];
  let eventsSeen = 0;
  let killed = false;
  let quitSent = false;

  const shoot = async (tick: number, trigger: string) => {
    const name = `shot-${String(tick).padStart(6, "0")}-${shots.length + 1}.png`;
    const ack = await qa.send({ cmd: "screenshot", path: `qa/${name}` }, deadline);
    const reported = typeof ack.path === "string" ? ack.path : `qa/${name}`;
    const src = path.isAbsolute(reported) ? reported : path.join(o.gameDir, reported);
    if (!existsSync(src)) throw new Error(`screenshot ack names ${reported}, but no file is there`);
    const dst = path.join(o.outDir, name);
    copyFileSync(src, dst);
    try {
      const img = decodePng(new Uint8Array(readFileSync(dst)));
      if (img.width !== o.resolution.w || img.height !== o.resolution.h)
        notes.push(`${name} is ${img.width}x${img.height}, not the requested ${o.resolution.w}x${o.resolution.h} (screenshot.md)`);
    } catch (e) {
      notes.push(`${name} is not a readable PNG: ${(e as Error).message}`);
    }
    shots.push({ file: dst, tick, trigger });
  };
  const currentTick = async (): Promise<number> => {
    await qa.send({ cmd: "dump_state" }, deadline);
    const state = JSON.parse(readFileSync(path.join(o.gameDir, "qa", "state.json"), "utf8"));
    if (!Number.isInteger(state.tick)) throw new Error("qa/state.json has no integer tick (state-dump.md)");
    return state.tick;
  };

  const run = async () => {
    if (o.mode.kind === "movie") {
      while (!exited()) {
        await Promise.race([sleep(0), spawnError]);
        if (Date.now() > deadline) throw new Error(`movie capture timed out after ${o.timeoutMs} ms (the game did not exit after ${o.mode.exit_after_ticks} ticks)`);
        await sleep(20);
      }
      return;
    }
    await Promise.race([qa.ready(deadline, spawnedAt), spawnError]);
    if (o.mode.kind === "ticks") {
      await qa.send({ cmd: "pause" }, deadline);
      let tick = await currentTick();
      for (const t of [...new Set(o.mode.ticks)].sort((a, b) => a - b)) {
        if (t < tick) {
          notes.push(`tick ${t} had already passed when capture paused (at ${tick}); skipped`);
          continue;
        }
        if (t > tick) await qa.send({ cmd: "step", frames: t - tick }, deadline);
        tick = t;
        await shoot(t, `tick ${t}`);
      }
    } else {
      const counts = new Map<number, number>();
      const taken = new Map<number, number>();
      const mode = o.mode;
      let over = false;
      while (!over && shots.length < mode.max_shots && !exited()) {
        if (Date.now() > deadline) {
          notes.push(`stopped at the deadline with ${shots.length} shot(s)`);
          break;
        }
        for (const ev of qa.newEvents()) {
          eventsSeen++;
          if (ev.event === "run_end") over = true;
          const i = mode.triggers.findIndex((t) => t.event === ev.event);
          if (i < 0 || shots.length >= mode.max_shots) continue;
          const tr = mode.triggers[i];
          const n = (counts.get(i) ?? 0) + 1;
          counts.set(i, n);
          if ((n - 1) % (tr.every ?? 1) !== 0 || (taken.get(i) ?? 0) >= (tr.max ?? Infinity)) continue;
          await qa.send({ cmd: "pause" }, deadline);
          const tick = await currentTick();
          await shoot(tick, `${ev.event} #${n} (event tick ${ev.tick})`);
          taken.set(i, (taken.get(i) ?? 0) + 1);
          await qa.send({ cmd: "resume" }, deadline);
        }
        await sleep(o.pollMs ?? 5);
      }
    }
    if (!exited()) {
      quitSent = true;
      await qa.send({ cmd: "quit" }, deadline).catch((e) => notes.push(`quit: ${(e as Error).message}`));
    }
  };

  let failure: unknown = null;
  try {
    await run();
  } catch (e) {
    failure = e;
  }
  // A quit lets the game exit on its own; anything left running after the grace period is killed.
  if (quitSent || o.mode.kind === "movie") for (const t0 = Date.now(); !exited() && Date.now() - t0 < graceMs; ) await sleep(10);
  killed = await stop(child, exited, graceMs);
  reaper?.untrack();
  if (killed && !failure) notes.push("the game did not exit after quit; killed");
  if (failure) {
    const err = failure as Error;
    err.message = `${err.message}${stderr.trim() ? `\n--- game stderr (tail) ---\n${stderr.trim().slice(-1500)}` : ""}`;
    throw err;
  }

  let movie: CaptureResult["movie"];
  if (o.mode.kind === "movie") {
    const f = o.mode.file;
    if (!existsSync(f) || statSync(f).size === 0) throw new Error(`movie mode finished but ${f} is missing or empty (exit ${JSON.stringify(exitInfo)})`);
    movie = { file: f, bytes: statSync(f).size };
  }
  const ex = exitInfo as { code: number | null; signal: string | null } | null;
  return { argv, shots, movie, exit: { code: ex?.code ?? null, signal: ex?.signal ?? null, killed }, events_seen: eventsSeen, notes, stderr_tail: stderr.slice(-1500) };
}
