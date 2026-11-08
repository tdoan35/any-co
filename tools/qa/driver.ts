// QA contract driver: launches a game and speaks the qa/ file protocol (docs/contracts/controls.md).
// The harness owns qa/control.json; the game owns ack/events/state/run_summary. Handshake is
// file-content id compare, never mtime. All harness writes are atomic (temp + rename).
// Readiness (controls.md): the game starts by clearing its outputs, writing control {id:0,noop}
// and ack {id:0,ok,ready}; the harness sends its first command only after that ack.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export const CONTRACT_FLAGS = [
  "qa",
  "seed",
  "time-scale",
  "autoplay",
  "policy",
  "resolution",
  "exit-after-ticks",
] as const;

export type ContractFlag = (typeof CONTRACT_FLAGS)[number];

export interface ContractArgs {
  qa: boolean;
  seed?: number;
  "time-scale"?: number;
  autoplay?: boolean;
  policy?: string;
  resolution?: string;
  "exit-after-ticks"?: number;
}

export function flagArgs(a: ContractArgs): string[] {
  const out: string[] = [];
  if (a.qa) out.push("--qa");
  if (a.seed !== undefined) out.push("--seed", String(a.seed));
  if (a["time-scale"] !== undefined) out.push("--time-scale", String(a["time-scale"]));
  if (a.autoplay) out.push("--autoplay");
  if (a.policy !== undefined) out.push("--policy", a.policy);
  if (a.resolution !== undefined) out.push("--resolution", a.resolution);
  if (a["exit-after-ticks"] !== undefined) out.push("--exit-after-ticks", String(a["exit-after-ticks"]));
  return out;
}

export interface Command {
  id: number;
  cmd: "pause" | "resume" | "step" | "dump_state" | "screenshot" | "quit";
  frames?: number;
  path?: string;
}

export interface Ack {
  id: number;
  ok: boolean;
  error?: string;
  ready?: boolean;
  [k: string]: unknown;
}

export interface RunEnd {
  reason: "exit" | "signal" | "timeout" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface Driver {
  /** Write the next command to qa/control.json and wait for the matching ack. */
  send(cmd: Omit<Command, "id">, timeoutMs?: number): Promise<Ack>;
  /** Events so far (tolerates a torn final line). */
  events(): object[];
  readState(): unknown;
  readRunSummary(): unknown;
  /** Resolves when the process ends for any reason; never rejects. */
  done(): Promise<RunEnd>;
  /** True once the process has ended (exit, signal, spawn error). */
  hasEnded(): boolean;
  /** SIGTERM, then SIGKILL after the grace (default 2s). */
 kill(graceMs?: number): void;
  readonly dir: string;
  readonly qaDir: string;
}

export interface LaunchOptions extends Partial<ContractArgs> {
  /** argv array; never a shell string (game_exec convention). */
  cmd: string[];
  /** Game repo root; qa/ lives under it. */
  cwd: string;
  /** Per-command ack timeout. Default 30s. */
  ackTimeoutMs?: number;
  /** Clear stale qa outputs (events/state/run_summary/ack/shot-*.png) before launch. Default true. */
  clean?: boolean;
}

/** Stale qa files from a previous run would be judged as this run's results (D2). */
export function cleanQaOutputs(qaDir: string): void {
  for (const f of ["events.jsonl", "state.json", "run_summary.json", "ack.json"]) {
    rmSync(path.join(qaDir, f), { force: true });
  }
  try {
    for (const f of readdirSync(qaDir)) {
      if (/^shot-.*\.png$/.test(f)) rmSync(path.join(qaDir, f), { force: true });
    }
  } catch {
    /* no dir yet */
  }
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function launch(opts: LaunchOptions): Driver {
  const { cmd, cwd } = opts;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) {
    throw new Error(`cmd must be a non-empty string[] argv, got ${JSON.stringify(cmd)}`);
  }
  const qaDir = path.join(cwd, "qa");
  if (opts.clean !== false) {
    mkdirSync(qaDir, { recursive: true });
    cleanQaOutputs(qaDir);
  } else {
    mkdirSync(qaDir, { recursive: true });
  }
  const control = path.join(qaDir, "control.json");
  atomicWrite(control, ""); // no id yet

  const argv = [...cmd, ...flagArgs({ qa: true, ...opts })];
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let ended: RunEnd | null = null;
  let endWaiters: Array<(r: RunEnd) => void> = [];
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;
  child.stdout!.on("data", () => {}); // drained; events come via qa/events.jsonl
  child.stderr!.on("data", (d) => {
    stderr += String(d);
  });
  const onEnd = () => {
    if (ended) return;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    ended = killed
      ? { reason: "signal", code: child.exitCode, signal: child.signalCode, stderr }
      : { reason: "exit", code: child.exitCode, signal: child.signalCode, stderr };
    for (const w of endWaiters) w(ended);
    endWaiters = [];
  };
  child.on("exit", onEnd);
  child.on("error", (err) => {
    if (ended) return;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    ended = { reason: "spawn-error", code: null, signal: null, stderr: `${stderr}${err.message}` };
    for (const w of endWaiters) w(ended);
    endWaiters = [];
  });

  const done = () => {
    if (ended) return Promise.resolve(ended);
    const { promise, resolve } = Promise.withResolvers<RunEnd>();
    endWaiters.push(resolve);
    return promise;
  };

  const driver: Driver = {
    dir: cwd,
    qaDir,
    send(cmd, timeoutMs = opts.ackTimeoutMs ?? 30_000) {
      return sendCommand(control, qaDir, () => ended !== null, cmd, timeoutMs);
    },
    events: () => readEvents(path.join(qaDir, "events.jsonl")),
    readState: () => readJson(path.join(qaDir, "state.json")),
    readRunSummary: () => readJson(path.join(qaDir, "run_summary.json")),
    done,
    hasEnded: () => ended !== null,
    kill(graceMs = 2_000) {
      killed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      // A game ignoring SIGTERM must not hang the CLI (D9): escalate to SIGKILL.
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, graceMs);
      killTimer.unref?.();
    },
  };
  return driver;
}

/** Wait for the game's ready ack ({id:0,ready:true}) before the first command (D1, controls.md). */
export async function waitReady(qaDir: string, timeoutMs = 30_000, isEnded: () => boolean = () => false): Promise<void> {
  const ackPath = path.join(qaDir, "ack.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isEnded()) throw new Error(`process ended before ready ack in ${qaDir}`);
    const ack = readJson(ackPath) as Ack | null;
    if (ack && ack.id === 0 && ack.ready === true) return;
    if (Date.now() > deadline) throw new Error(`ready timeout: no {id:0,ready:true} ack in ${qaDir} after ${timeoutMs}ms`);
    await sleep(10);
  }
}

async function sendCommand(
  control: string,
  qaDir: string,
  isEnded: () => boolean,
  cmd: Omit<Command, "id">,
  timeoutMs: number,
): Promise<Ack> {
  const id = nextId();
  atomicWrite(control, JSON.stringify({ id, ...cmd }));
  const ackPath = path.join(qaDir, "ack.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isEnded()) throw new Error(`process ended while waiting for ack id ${id}`);
    const ack = readJson(ackPath) as Ack | null;
    if (ack && ack.id === id) return ack; // id compare; stale acks ignored
    if (Date.now() > deadline) {
      throw new Error(`ack timeout: no ack with id ${id} in ${qaDir} after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

let lastId = 0;
function nextId(): number {
  return ++lastId; // increasing ids, harness-owned (controls.md); id 0 is the game's ready marker
}

export function resetIds(): void {
  lastId = 0;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // torn write mid-poll; caller retries or fails on evidence
  }
}

function readEvents(file: string): object[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l: string) => {
      try {
        return JSON.parse(l) as object;
      } catch {
        return { torn: l }; // keep going; a torn last line must not kill a run's verdict
      }
    });
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
