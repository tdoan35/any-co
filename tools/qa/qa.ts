// QA CLI: npm run qa -- <smoke|check|determinism> ... (see tools/qa/README.md).
// Exit codes: 0 pass, 1 invariant failure, 2 harness/usage error.
import { readFileSync } from "node:fs";
import path from "node:path";
import { launch, resetIds, type Driver, type RunEnd } from "./driver.ts";
import { firstDifference, runInvariants, type Check, type RunFiles } from "./invariants.ts";

interface Cli {
  sub: "smoke" | "check" | "determinism";
  cmd?: string; // JSON argv array, e.g. '["node","game.js"]'
  dir: string; // game dir (smoke/determinism) or qa dir (check)
  seed: number;
  ticks: number;
  policy?: string;
  maxEntities: number;
  identicalDumps: number;
  ackTimeoutMs: number;
  endWaitMs?: number; // bound on the natural-run wait before quit/kill; default ack*2+60s
}

function usage(): never {
  console.error(
    [
      "usage: qa smoke --cmd '<json argv>' --dir <game dir> --seed N --ticks N [--policy ID] [--max-entities N] [--identical-dumps N] [--ack-timeout-ms N]",
      "       qa check --dir <qa dir> [--max-entities N] [--identical-dumps N]",
      "       qa determinism --cmd '<json argv>' --dir <game dir> --seed N --ticks N",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgv(argv: string[]): Cli {
  const sub = argv[0] as Cli["sub"];
  if (sub !== "smoke" && sub !== "check" && sub !== "determinism") usage();
  const cli: Cli = { sub, dir: ".", seed: 0, ticks: 0, maxEntities: 500, identicalDumps: 2, ackTimeoutMs: 30_000 };
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (v === undefined) usage();
    switch (k) {
      case "--cmd": cli.cmd = v; break;
      case "--dir": cli.dir = v; break;
      case "--seed": cli.seed = Number(v); break;
      case "--ticks": cli.ticks = Number(v); break;
      case "--policy": cli.policy = v; break;
      case "--max-entities": cli.maxEntities = Number(v); break;
      case "--identical-dumps": cli.identicalDumps = Number(v); break;
      case "--ack-timeout-ms": cli.ackTimeoutMs = Number(v); break;
      case "--end-wait-ms": cli.endWaitMs = Number(v); break;
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

interface RunResult {
  files: RunFiles;
  end: RunEnd | null;
  commandError?: string;
}

/** Drive one run: launch with contract flags, then drive deterministically via pause/step/dump
 *  (the contract's own mechanism — no wall-clock races), bounded wait, quit/kill on timeout. */
async function driveRun(cli: Cli): Promise<RunResult> {
  resetIds();
  const gameDir = path.resolve(cli.dir);
  const driver: Driver = launch({
    cmd: parseCmd(cli.cmd!),
    cwd: gameDir,
    seed: cli.seed,
    qa: true,
    autoplay: true,
    policy: cli.policy,
    "exit-after-ticks": cli.ticks,
    ackTimeoutMs: cli.ackTimeoutMs,
  });
  const endPromise = driver.done();
  const states: unknown[] = [];
  const snapshot = () => {
    const s = driver.readState();
    if (s) states.push(s);
  };

  // Command path, deterministic: pause, then step in chunks, sampling after each.
  // A failed command is a harness error (exit 2) but must not swallow the run-end report.
  let commandError: string | undefined;
  const runCommand = async (cmd: Parameters<Driver["send"]>[0]) => {
    try {
      const ack = await driver.send(cmd, cli.ackTimeoutMs);
      if (!ack.ok) commandError = `${cmd.cmd} ack error: ${ack.error ?? "unknown"}`;
      return true;
    } catch (e) {
      commandError = `${cmd.cmd}: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    }
  };
  const STEP = 5;
  if (await runCommand({ cmd: "pause" })) {
    for (let done = 0; done < cli.ticks && !commandError; done += STEP) {
      if (!(await runCommand({ cmd: "step", frames: STEP }))) break;
      snapshot();
      const s = driver.readState() as { run?: { over?: boolean } } | null;
      if (s?.run?.over) break; // run ended under step; resume would hang on a dead process
    }
    const s = driver.readState() as { run?: { over?: boolean } } | null;
    if (!s?.run?.over && !driver.hasEnded()) await runCommand({ cmd: "resume" }); // skip if the process is gone (crash-mid)
  }
  snapshot();

  // Bounded wait for natural end; on timeout send quit, then kill, and report how it ended.
  const endWaitMs = cli.endWaitMs ?? cli.ackTimeoutMs * 2 + 60_000;
  let end: RunEnd;
  try {
    end = await withTimeout(endPromise, endWaitMs, "run end");
  } catch {
    try {
      await driver.send({ cmd: "quit" }, cli.ackTimeoutMs);
      end = await withTimeout(driver.done(), 5_000, "quit grace");
    } catch {
      driver.kill();
      end = await driver.done();
      end.reason = "timeout";
    }
  }
  if (commandError && !driver.hasEnded()) throw new Error(commandError); // live-process command failure: harness error
  // a 200ms ack timeout that fires while the run is still live is the harness's contract failure (exit 2),
  // even if the run then ended on its own; only pure ended-during-command (crash-mid) stays a checked failure
  if (commandError && /ended/.test(commandError)) {
    const end = driver.hasEnded();
    const endWait = cli.endWaitMs ?? cli.ackTimeoutMs * 2 + 60_000;
    if (!end && endWait >= cli.ackTimeoutMs * 2) throw new Error(commandError); // process alive at error time
  }
  return {
    files: {
      states: dedupeConsecutive(states),
      finalState: driver.readState(),
      events: driver.events(),
      runSummary: driver.readRunSummary(),
    },
    end,
    commandError,
  };
}

/** Keep repeats only when identical (softlock signal), drop duplicates that merely re-read the same file. */
function dedupeConsecutive(states: unknown[]): unknown[] {
  const out: unknown[] = [];
  let last = "";
  for (const s of states) {
    const json = JSON.stringify(s);
    if (json !== last || out.length === 0) {
      // push repeats of an unchanged state too: a stalled sim shows identical consecutive dumps
    }
    if (json === last && out.length > 0 && out.at(-1) === s) continue;
    out.push(s);
    last = json;
  }
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface QaResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  checks?: Check[];
  error?: string;
  end?: Omit<RunEnd, "stderr"> & { stderrTail: string };
}

function worst(checks: Check[]): 0 | 1 {
  return checks.every((c) => c.pass) ? 0 : 1;
}

export async function smoke(cli: Cli): Promise<QaResult> {
  try {
    const run = await driveRun({ ...cli });
    const checks = runInvariants(run.files, { maxEntities: cli.maxEntities, identicalDumps: cli.identicalDumps });
    return {
      ok: run.end?.reason === "exit" && (run.end.code === 0 || run.end.code === null) && worst(checks) === 0,
      exitCode: worst(checks),
      checks,
      error: run.commandError,
      end: summarizeEnd(run.end),
    };
  } catch (e) {
    return { ok: false, exitCode: 2, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function determinism(cli: Cli): Promise<QaResult> {
  try {
    const a = await driveRun({ ...cli });
    const b = await driveRun({ ...cli });
    const aFinal = a.files.finalState;
    const bFinal = b.files.finalState;
    const diff = firstDifference(aFinal, bFinal);
    if (a.end?.reason !== "exit" || b.end?.reason !== "exit" || a.end.code !== 0 || b.end.code !== 0) {
      return { ok: false, exitCode: 2, error: `a run did not exit 0 (a=${JSON.stringify(a.end?.reason)}, b=${JSON.stringify(b.end?.reason)})` };
    }
    return diff === null
      ? { ok: true, exitCode: 0, checks: [{ name: "determinism", pass: true, detail: "final dumps identical" }] }
      : { ok: false, exitCode: 1, error: `final dumps differ at ${diff}` };
  } catch (e) {
    return { ok: false, exitCode: 2, error: e instanceof Error ? e.message : String(e) };
  }
}

export function check(cli: Cli): QaResult {
  const qaDir = path.resolve(cli.dir);
    const read = (f: string): unknown => JSON.parse(readFileSync(path.join(qaDir, f), "utf8"));
  let finalState: unknown;
  let runSummary: unknown;
  try {
    finalState = read("state.json");
    runSummary = read("run_summary.json");
  } catch (e) {
    return { ok: false, exitCode: 2, error: `missing/unreadable qa files in ${qaDir}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const eventsFile = path.join(qaDir, "events.jsonl");
  const events: unknown[] = (() => {
    try {
      return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  })();
  const states = [finalState]; // offline: only the final dump is retained by the game
  const checks = runInvariants({ states, finalState, events, runSummary }, {
    maxEntities: cli.maxEntities,
    identicalDumps: cli.identicalDumps,
  });
  return { ok: worst(checks) === 0, exitCode: worst(checks), checks };
}

function summarizeEnd(end: RunEnd | null): QaResult["end"] {
  if (!end) return undefined;
  const { stderr, ...rest } = end;
  return { ...rest, stderrTail: stderr.slice(-2000) };
}

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));
  let result: QaResult;
  if (cli.sub === "smoke") result = await smoke(cli);
  else if (cli.sub === "determinism") result = await determinism(cli);
  else result = check(cli);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.exitCode);
}

if (process.argv[1]?.endsWith("qa.ts")) {
  void main();
}

export { runInvariants, firstDifference } from "./invariants.ts";
