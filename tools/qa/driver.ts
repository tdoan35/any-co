// QA contract driver: launches a game and speaks the qa/ file protocol (docs/contracts/controls.md).
// The game owns qa/ack.json, qa/events.jsonl, qa/state.json, qa/run_summary.json;
// the harness owns qa/control.json. Handshake is file-content id compare, never mtime.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Events so far (tolerates a torn final line, like the ledger reader). */
  events(): object[];
  readState(): unknown;
  readRunSummary(): unknown;
  /** Resolves when the process ends for any reason; never rejects. */
  done(): Promise<RunEnd>;
  /** True once the process has ended (exit, signal, spawn error). */
  hasEnded(): boolean;
  kill(signal?: NodeJS.Signals): void;
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
}

export function launch(opts: LaunchOptions): Driver {
  const { cmd, cwd } = opts;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) {
    throw new Error(`cmd must be a non-empty string[] argv, got ${JSON.stringify(cmd)}`);
  }
  const qaDir = path.join(cwd, "qa");
  mkdirSync(qaDir, { recursive: true });
  const control = path.join(qaDir, "control.json");
  writeFileSync(control, ""); // no id yet; game treats missing/empty as nothing to do

  const argv = [...cmd, ...flagArgs({ qa: true, ...opts })];
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let ended: RunEnd | null = null;
  let endWaiters: Array<(r: RunEnd) => void> = [];
  let killed = false;
  child.stdout!.on("data", () => {}); // drained; events come via qa/events.jsonl
  child.stderr!.on("data", (d) => {
    stderr += String(d);
  });
  const onEnd = () => {
    if (ended) return;
    ended = killed
      ? { reason: "signal", code: child.exitCode, signal: child.signalCode, stderr }
      : { reason: "exit", code: child.exitCode, signal: child.signalCode, stderr };
    for (const w of endWaiters) w(ended);
    endWaiters = [];
  };
  child.on("exit", onEnd);
  child.on("error", (err) => {
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
      // A dead child never acks: fail the send as soon as the process is gone.
      const dead = ended !== null ? Promise.reject(new Error(`process ended (${ended.reason}) before ack`)) : null;
      if (dead) return dead as Promise<Ack>;
      return Promise.race([
        sendCommand(control, qaDir, cmd, timeoutMs),
        new Promise<Ack>((_, rej) => {
          const t = setInterval(() => {
            if (ended !== null) {
              clearInterval(t);
              rej(new Error(`process ended (${ended!.reason}) while waiting for ack`));
            }
          }, 20);
          void timeoutMs;
        }),
      ]);
    },
    events: () => readEvents(path.join(qaDir, "events.jsonl")),
    readState: () => (existsSync(path.join(qaDir, "state.json")) ? JSON.parse(readFileSync(path.join(qaDir, "state.json"), "utf8")) : null),
    readRunSummary: () =>
      existsSync(path.join(qaDir, "run_summary.json"))
        ? JSON.parse(readFileSync(path.join(qaDir, "run_summary.json"), "utf8"))
        : null,
    done,
    hasEnded: () => ended !== null,
    kill(signal) {
      killed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal ?? "SIGTERM");
    },
  };
  return driver;
}

async function sendCommand(control: string, qaDir: string, cmd: Omit<Command, "id">, timeoutMs: number): Promise<Ack> {
  const id = nextId();
  writeFileSync(control, JSON.stringify({ id, ...cmd })); // atomic enough: content-id compare, not mtime
  const ackPath = path.join(qaDir, "ack.json");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(ackPath)) {
      try {
        const ack = JSON.parse(readFileSync(ackPath, "utf8")) as Ack;
        if (ack?.id === id) return ack; // id compare, per controls.md; stale acks ignored
      } catch {
        /* torn write mid-poll; retry */
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`ack timeout: no ack with id ${id} in ${qaDir} after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

let lastId = 0;
function nextId(): number {
  return ++lastId; // increasing ids, harness-owned (controls.md)
}

export function resetIds(): void {
  lastId = 0;
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
