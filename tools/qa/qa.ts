// QA CLI: npm run qa -- <smoke|check|determinism> ... (see tools/qa/README.md).
// Exit codes: 0 pass, 1 invariant failure (incl. an unclean process end), 2 harness/usage error.
import { readFileSync } from "node:fs";
import path from "node:path";
import { launch, resetIds, waitReady, type Driver, type RunEnd } from "./driver.ts";
import { firstDifference, runInvariants, type Check, type InvariantOptions, type RunFiles } from "./invariants.ts";

export interface Cli {
  sub: "smoke" | "check" | "determinism";
  cmd?: string; // JSON argv array, e.g. '["godot","--path","."]'
  dir: string; // game dir (smoke/determinism) or qa dir (check)
  seed: number;
  ticks: number;
  policy?: string;
  maxEntities: number;
  identicalDumps: number;
  tickRate: number;
  ackTimeoutMs: number;
  readyTimeoutMs: number;
  endWaitMs?: number; // bound on the wait for a natural end before quit/kill; default ack*2+60s
  stepFrames: number;
}

export const CLI_DEFAULTS: Omit<Cli, "sub"> = {
  dir: ".",
  seed: 0,
  ticks: 0,
  maxEntities: 500,
  identicalDumps: 2,
  tickRate: 60,
  ackTimeoutMs: 30_000,
  readyTimeoutMs: 30_000,
  stepFrames: 5,
};

function usage(): never {
  console.error(
    [
      "usage: qa smoke --cmd '<json argv>' --dir <game dir> --seed N --ticks N [--policy ID] [--step-frames N]",
      "                [--max-entities N] [--identical-dumps N] [--tick-rate N] [--ack-timeout-ms N] [--ready-timeout-ms N] [--end-wait-ms N]",
      "       qa check --dir <qa dir> [--max-entities N] [--identical-dumps N] [--tick-rate N]",
      "       qa determinism --cmd '<json argv>' --dir <game dir> --seed N --ticks N [same options as smoke]",
    ].join("\n"),
  );
  process.exit(2);
}

function num(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) usage();
  return n;
}

export function parseArgv(argv: string[]): Cli {
  const sub = argv[0] as Cli["sub"];
  if (sub !== "smoke" && sub !== "check" && sub !== "determinism") usage();
  const cli: Cli = { sub, ...CLI_DEFAULTS };
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (v === undefined) usage();
    switch (k) {
      case "--cmd": cli.cmd = v; break;
      case "--dir": cli.dir = v; break;
      case "--seed": cli.seed = num(v); break;
      case "--ticks": cli.ticks = num(v); break;
      case "--policy": cli.policy = v; break;
      case "--step-frames": cli.stepFrames = num(v); break;
      case "--max-entities": cli.maxEntities = num(v); break;
      case "--identical-dumps": cli.identicalDumps = num(v); break;
      case "--tick-rate": cli.tickRate = num(v); break;
      case "--ack-timeout-ms": cli.ackTimeoutMs = num(v); break;
      case "--ready-timeout-ms": cli.readyTimeoutMs = num(v); break;
      case "--end-wait-ms": cli.endWaitMs = num(v); break;
      default: usage();
    }
  }
  if ((cli.sub === "smoke" || cli.sub === "determinism") && !cli.cmd) usage();
  if (cli.sub === "check" && cli.cmd) usage();
  return cli;
}

export function parseCmd(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`--cmd is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((c) => typeof c !== "string")) {
    throw new Error(`--cmd must be a JSON string[] argv, got ${json}`);
  }
  return parsed;
}

export interface RunResult {
  files: RunFiles;
  end: RunEnd;
  /** Set when the run hit the end-wait bound and had to be quit or killed. */
  forcedEnd?: "quit" | "kill";
}

class HarnessError extends Error {}

function isRunOver(state: unknown): boolean {
  if (!state || typeof state !== "object" || !("run" in state)) return false;
  const run = state.run;
  return !!run && typeof run === "object" && "over" in run && run.over === true;
}

function numField(state: unknown, key: string): number | undefined {
  if (!state || typeof state !== "object" || !(key in state)) return undefined;
  const v = (state as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/** True when the game ended its run on its own: run_end event + run_summary on disk (it exits right after). */
function endedNaturally(driver: Driver): boolean {
  return driver.readRunSummary() !== null && driver.events().some((e) => "event" in e && e.event === "run_end");
}

/** One run: launch → ready handshake → pause → (step N + dump_state)* → resume → bounded wait for end.
 *  Throws HarnessError only for harness/protocol failures on a live process. */
export async function driveRun(cli: Cli): Promise<RunResult> {
  resetIds();
  const driver = launch({
    cmd: parseCmd(cli.cmd!),
    cwd: path.resolve(cli.dir),
    seed: cli.seed,
    qa: true,
    autoplay: true,
    policy: cli.policy,
    "exit-after-ticks": cli.ticks,
    ackTimeoutMs: cli.ackTimeoutMs,
  });
  const states: unknown[] = [];
  try {
    await waitReady(driver.qaDir, cli.readyTimeoutMs, () => driver.hasEnded());

    // A command can lose to a natural end: the game exits after run_end + run_summary, so it never acks.
    // That is a clean end, not a protocol failure.
    const send = async (cmd: Parameters<Driver["send"]>[0]): Promise<boolean> => {
      try {
        const ack = await driver.send(cmd, cli.ackTimeoutMs);
        if (!ack.ok) throw new HarnessError(`${cmd.cmd} ack error: ${ack.error ?? "unknown"}`);
        return true;
      } catch (e) {
        if (e instanceof HarnessError) throw e;
        if (driver.hasEnded() || endedNaturally(driver)) return false;
        throw new HarnessError(`${cmd.cmd}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    if (await send({ cmd: "pause" })) {
      // Anchor the step grid to the tick count (R8b F1): --autoplay starts ticking at launch, so
      // the pause lands at an arbitrary tick; a first partial step puts every later boundary on a
      // multiple of stepFrames, making dumps and verdicts independent of wall-clock pause timing.
      let firstFrames = 0;
      if (await send({ cmd: "dump_state" })) {
        const startTick = numField(driver.readState(), "tick") ?? 0;
        firstFrames = cli.stepFrames - (startTick % cli.stepFrames);
      }
      for (let stepped = 0; stepped < cli.ticks; stepped += cli.stepFrames) {
        const frames = stepped === 0 ? firstFrames : cli.stepFrames;
        if (!(await send({ cmd: "step", frames }))) break;
        if (!(await send({ cmd: "dump_state" }))) break;
        const s = driver.readState();
        if (s !== null) states.push(s);
        if (isRunOver(s)) break;
      }
      if (!driver.hasEnded() && !endedNaturally(driver)) await send({ cmd: "resume" });
    }
  } catch (e) {
    driver.kill();
    const end = await driver.done();
    const msg = e instanceof Error ? e.message : String(e);
    throw new HarnessError(end?.stderr ? `${msg}; game stderr: ${end.stderr.slice(-300)}` : msg);
  }

  const endWaitMs = cli.endWaitMs ?? cli.ackTimeoutMs * 2 + 60_000;
  let forcedEnd: RunResult["forcedEnd"];
  let end = await raceTimeout(driver.done(), endWaitMs);
  if (!end) {
    forcedEnd = "quit";
    try {
      await driver.send({ cmd: "quit" }, cli.ackTimeoutMs);
    } catch {
      /* fall through to kill */
    }
    end = await raceTimeout(driver.done(), 5_000);
    if (!end) {
      forcedEnd = "kill";
      driver.kill();
      end = { ...(await driver.done()), reason: "timeout" };
    }
  }
  const finalState = driver.readState();
  if (finalState !== null && (states.length === 0 || JSON.stringify(states.at(-1)) !== JSON.stringify(finalState))) {
    states.push(finalState);
  }
  return {
    files: { states, finalState, events: driver.events(), runSummary: driver.readRunSummary() },
    end,
    forcedEnd,
  };
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

export interface QaResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  checks?: Check[];
  error?: string;
  end?: Omit<RunEnd, "stderr"> & { stderrTail: string; forced?: "quit" | "kill" };
}

/** The process end is a verdict too (D3): only a clean exit 0 without a forced quit/kill passes. */
export function endCheck(end: RunEnd, forced?: "quit" | "kill"): Check {
  const pass = end.reason === "exit" && end.code === 0 && !forced;
  return {
    name: "process_exit_clean",
    pass,
    detail: `reason=${end.reason} code=${JSON.stringify(end.code)} signal=${JSON.stringify(end.signal)}${forced ? ` forced=${forced}` : ""}`,
  };
}

function verdict(checks: Check[], end: RunEnd, forced?: "quit" | "kill"): QaResult {
  const all = [...checks, endCheck(end, forced)];
  if (end.reason === "spawn-error") {
    return { ok: false, exitCode: 2, checks: all, error: `spawn failed: ${end.stderr.slice(-500)}`, end: summarizeEnd(end, forced) };
  }
  const pass = all.every((c) => c.pass);
  return { ok: pass, exitCode: pass ? 0 : 1, checks: all, end: summarizeEnd(end, forced) };
}

function invariantOpts(cli: Cli): InvariantOptions {
  return { maxEntities: cli.maxEntities, identicalDumps: cli.identicalDumps, tickRate: cli.tickRate };
}

const harnessError = (e: unknown): QaResult => ({ ok: false, exitCode: 2, error: e instanceof Error ? e.message : String(e) });

export async function smoke(cli: Cli): Promise<QaResult> {
  try {
    const run = await driveRun(cli);
    return verdict(runInvariants(run.files, invariantOpts(cli)), run.end, run.forcedEnd);
  } catch (e) {
    return harnessError(e);
  }
}

export async function determinism(cli: Cli): Promise<QaResult> {
  try {
    const a = await driveRun(cli); // launch() clears qa/ outputs before each run
    const b = await driveRun(cli);
    const endA = endCheck(a.end, a.forcedEnd);
    const endB = endCheck(b.end, b.forcedEnd);
    if (!endA.pass || !endB.pass) {
      return { ok: false, exitCode: 1, checks: [{ ...endA, name: "run_a_exit_clean" }, { ...endB, name: "run_b_exit_clean" }], error: `a run did not end cleanly (a: ${endA.detail}; b: ${endB.detail})` };
    }
    if (a.files.finalState === null || b.files.finalState === null) {
      return { ok: false, exitCode: 1, error: `missing final state dump (a=${a.files.finalState !== null}, b=${b.files.finalState !== null})` };
    }
    const diff = firstDifference(a.files.finalState, b.files.finalState);
    return diff === null
      ? { ok: true, exitCode: 0, checks: [{ name: "determinism", pass: true, detail: "final dumps identical" }] }
      : { ok: false, exitCode: 1, checks: [{ name: "determinism", pass: false, detail: diff }], error: `final dumps differ at ${diff}` };
  } catch (e) {
    return harnessError(e);
  }
}

export function check(cli: Cli): QaResult {
  const qaDir = path.resolve(cli.dir);
  const read = (f: string): unknown => JSON.parse(readFileSync(path.join(qaDir, f), "utf8"));
  let finalState: unknown;
  let runSummary: unknown;
  let events: unknown[];
  try {
    finalState = read("state.json");
    runSummary = read("run_summary.json");
    events = readFileSync(path.join(qaDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { torn: l };
      }
    });
  } catch (e) {
    return { ok: false, exitCode: 2, error: `missing/unreadable qa files in ${qaDir}: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Offline: only the final dump survives a run, so softlock/tick-advance have one data point.
  const checks = runInvariants({ states: [finalState], finalState, events, runSummary }, invariantOpts(cli));
  const pass = checks.every((c) => c.pass);
  return { ok: pass, exitCode: pass ? 0 : 1, checks };
}

function summarizeEnd(end: RunEnd, forced?: "quit" | "kill"): QaResult["end"] {
  const { stderr, ...rest } = end;
  return { ...rest, stderrTail: stderr.slice(-2000), ...(forced ? { forced } : {}) };
}

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));
  const result = cli.sub === "smoke" ? await smoke(cli) : cli.sub === "determinism" ? await determinism(cli) : check(cli);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.exitCode);
}

if (process.argv[1]?.endsWith("qa.ts")) {
  void main();
}
