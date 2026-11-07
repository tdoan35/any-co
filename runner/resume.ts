// Crash recovery for local runs (AGENTS.md rule 7). A run stuck at status "running" whose
// process is gone (see liveness.ts) is rebuilt from its transcript and continued under the
// same run id, workspace and spend. Anything that cannot be rebuilt exactly is refused.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { specHash } from "./load.ts";
import { runAgent, RUNS_DIR, type Approver, type RunResult } from "./run.ts";
import { SpendLedger } from "./spend.ts";
import { orphanStatus } from "./liveness.ts";
import type { AgentSpec } from "./spec.ts";
import type { NaiveClient } from "./providers.ts";
import type { Block, Message, Provider, ToolResultBlock, ToolUseBlock } from "./types.ts";

const CRASH_RESULT = "interrupted by a crash; check the current state before retrying";

export interface ResumeOptions {
  provider: Provider;
  naive: NaiveClient | null;
  approver?: Approver;
  runCapUsd?: number;
  runsDir?: string;
  log?: (line: string) => void;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

export type TEvent = Record<string, unknown> & { ts: string; type: string };

/**
 * Parse transcript.jsonl. A torn last line (crash mid-write) is dropped; a bad line anywhere
 * else is corruption and refuses the resume.
 */
export function readEvents(dir: string): TEvent[] {
  const file = path.join(dir, "transcript.jsonl");
  if (!existsSync(file)) throw new Error(`no transcript.jsonl in ${dir}; nothing to rebuild`);
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events: TEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let e: unknown;
    try {
      e = JSON.parse(lines[i]);
      if (!(e instanceof Object) || typeof (e as TEvent).type !== "string" || typeof (e as TEvent).ts !== "string") {
        throw new Error("not an event");
      }
    } catch {
      if (i === lines.length - 1) break; // torn write at the moment of the crash
      throw new Error(`transcript line ${i + 1} of ${dir} is corrupt; refusing to resume from a partial record`);
    }
    events.push(e as TEvent);
  }
  return events;
}

export interface RebuiltConversation {
  messages: Message[];
  /** Turn of the last recorded request; the loop continues from here. */
  turns: number;
  wrapUp: boolean;
  task: string;
}

/** Same logic as the runner's noteToLastUser: append to the last user turn, else open one. */
function appendNote(messages: Message[], text: unknown) {
  const t = typeof text === "string" ? text : "";
  const last = messages[messages.length - 1];
  if (last?.role !== "user") messages.push({ role: "user", content: t });
  else if (typeof last.content === "string") last.content += "\n\n" + t;
  else last.content.push({ type: "text", text: t });
}

/**
 * Rebuild the exact message list: the start event's history + task, then every `msg` and
 * `note` event in order. The runner records each message as sent, so this is a replay of
 * facts, never a reconstruction by guesswork.
 */
export function rebuildConversation(events: TEvent[]): RebuiltConversation {
  const start = events.find((e) => e.type === "start");
  if (!start) throw new Error("transcript has no start event; the original conversation cannot be proven");
  if (typeof start.task !== "string") throw new Error("start event has no task; cannot rebuild the first message");
  const history = Array.isArray(start.history) ? structuredClone(start.history) : [];
  const messages: Message[] = [...(history as Message[]), { role: "user", content: start.task }];
  for (const e of events) {
    if (e.type === "msg" && (e.role === "user" || e.role === "assistant")) {
      messages.push({ role: e.role, content: e.content as string | Block[] });
    } else if (e.type === "note") {
      appendNote(messages, e.text);
    }
  }
  const requestTurns = events.filter((e) => e.type === "request").map((e) => Number(e.turn) || 0);
  return {
    messages,
    turns: requestTurns.length ? Math.max(...requestTurns) : 0,
    wrapUp: events.some((e) => e.type === "wrap_up"),
    task: start.task,
  };
}

/**
 * A crash mid-turn leaves the last assistant tool calls unanswered. Answer each one without
 * re-executing it: replay a recorded result verbatim (a clipped record is no longer exact, so
 * it gets the crash notice too); an unanswered submit replays its recorded verdict; anything
 * else gets the crash notice. `ask` tools (sends, uploads) must never fire twice.
 * Returns the names that were answered with the crash notice.
 */
export function repairInterruptedTurn(messages: Message[], events: TEvent[]): string[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
  const uses = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (!uses.length) return [];
  // Only events after the last recorded message belong to the interrupted turn.
  const lastMsg = events.reduce((acc, e, i) => (e.type === "msg" ? i : acc), -1);
  const tail = events.slice(lastMsg + 1);
  const repaired: string[] = [];
  const results: ToolResultBlock[] = uses.map((u) => {
    const ev = tail.find((e) => e.type === "tool" && e.id === u.id);
    if (ev) {
      if (ev.error !== undefined) {
        return { type: "tool_result", tool_use_id: u.id, content: String(ev.error), is_error: true };
      }
      if (typeof ev.content === "string" && !ev.clipped) {
        return { type: "tool_result", tool_use_id: u.id, content: ev.content, ...(ev.is_error ? { is_error: true } : {}) };
      }
    } else if (u.name === "submit_result") {
      const sub = tail.find((e) => e.type === "submit");
      if (sub) {
        return sub.ok === true
          ? { type: "tool_result", tool_use_id: u.id, content: "accepted" }
          : { type: "tool_result", tool_use_id: u.id, content: `rejected, fix and resubmit: ${String(sub.why)}`, is_error: true };
      }
    }
    repaired.push(u.name);
    return { type: "tool_result", tool_use_id: u.id, content: CRASH_RESULT, is_error: true };
  });
  messages.push({ role: "user", content: results });
  return repaired;
}

/**
 * Continue an orphaned run (same run id, workspace, spend ledger and caps). Refuses with a
 * clear reason when the run is not dead, already finished, recorded by an older runner, or
 * not exactly rebuildable.
 */
export async function resumeRun(spec: AgentSpec, runId: string, opts: ResumeOptions): Promise<RunResult> {
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const dir = path.join(runsDir, runId);
  const runFile = path.join(dir, "run.json");
  if (!existsSync(runFile)) throw new Error(`run "${runId}" not found under ${runsDir}`);
  const run = JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>;
  if (run.agent !== spec.name) throw new Error(`run "${runId}" belongs to agent "${String(run.agent)}", not "${spec.name}"`);
  if (run.spec_hash !== specHash(spec)) throw new Error(`spec "${spec.name}" changed since the crash (${String(run.spec_hash)} ≠ ${specHash(spec)}); refusing to resume`);
  if (run.status !== "running") throw new Error(`run "${runId}" finished with status "${String(run.status)}"; only runs stuck at "running" can be resumed`);
  const verdict = orphanStatus(run);
  if (!verdict.orphaned) {
    throw new Error(`run "${runId}" still looks alive (pid ${String(run.pid)} on ${String(run.host)}, heartbeat ${(verdict.heartbeat_age_min ?? 0).toFixed(1)} min old); not resuming a live run`);
  }

  const events = readEvents(dir);
  if (events.some((e) => e.type === "request") && !events.some((e) => e.type === "msg")) {
    throw new Error(`run "${runId}" was recorded before exact message logging existed (no msg events); it cannot be rebuilt exactly`);
  }
  const convo = rebuildConversation(events);
  const repaired = repairInterruptedTurn(convo.messages, events);
  const ledger = new SpendLedger(path.join(runsDir, "spend.jsonl"));
  const mine = ledger.entries().filter((e) => e.run_id === runId);
  const spent = mine.reduce((s, e) => s + e.micro_usd, 0);
  const maxCallCost = mine.filter((e) => e.kind === "model").reduce((m, e) => Math.max(m, e.micro_usd), 0);
  opts.log?.(`resuming from turn ${convo.turns}: ${verdict.reason}${repaired.length ? `; answered as crashed: ${repaired.join(", ")}` : ""}`);
  return runAgent(spec, {
    task: convo.task,
    provider: opts.provider,
    naive: opts.naive,
    approver: opts.approver,
    runCapUsd: opts.runCapUsd,
    runsDir,
    log: opts.log,
    onEvent: opts.onEvent,
    resume: {
      runId,
      startedAt: typeof run.started_at === "string" ? run.started_at : new Date().toISOString(),
      messages: convo.messages,
      turns: convo.turns,
      spentMicroUsd: spent,
      maxCallCost,
      wrapUp: convo.wrapUp,
      reason: verdict.reason ?? "process is gone",
    },
  });
}
