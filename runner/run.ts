// Local runner: runs one agent spec on one task with a tool loop.
// Writes everything to runs/<run_id>/: run.json (status, spend), transcript.jsonl (every request,
// reply, tool call, approval), output.json (validated result), workspace/ (agent files).
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ROOT, outputJsonSchema, specHash } from "./load.ts";
import type { AgentSpec, Permission } from "./spec.ts";
import type { CapabilityName } from "./tools/registry.ts";
import { IMPLS, TOOL_INDEX, clip, type ToolContext } from "./tools/impl.ts";
import { SpendLedger, killSwitchOn, limitsFor } from "./spend.ts";
import { wireMessages } from "./images.ts";
import type { Block, Message, Provider, ToolDef, ToolResultBlock, ToolUseBlock } from "./types.ts";
import type { NaiveClient } from "./providers.ts";
import type { Board } from "./board/index.ts";

export const RUNS_DIR = path.join(ROOT, "runs");
const SUBMIT = "submit_result";
const MAX_NUDGES = 2;

export type RunStatus = "running" | "done" | "budget_exceeded" | "max_turns" | "killed" | "stuck" | "error";

// Loop guard: the same failing call (name + input) this many times in a row gets a warning,
// then stops the run. Cheap insurance against a model repeating one broken call to max_turns.
// Wrap-up: once 70% of the run budget is spent, or the remaining budget covers fewer than 3 calls
// (at the most expensive call so far), or 2 turns remain, the agent is told to submit and every
// other tool call is rejected, so the run ends with an output. The tool list itself is unchanged:
// changing it breaks the prompt cache and made the final call ~4x more expensive (Nov 7 test).
export const WRAP_UP_CALLS = 3;
export const WRAP_UP_SPENT = 0.7;
export const LOOP_WARN = 3;

/**
 * Salvage a submission whose only problems are strings over their max length: trim those
 * strings to the limit and re-validate. Anything else (missing fields, wrong types) is not
 * touched. Returns the parsed value, or null if it can't be salvaged.
 */
export function salvageTooLong(schema: z.ZodType, input: unknown): { data: unknown; trimmed: string[] } | null {
  const first = schema.safeParse(input);
  if (first.success) return { data: first.data, trimmed: [] };
  const issues = first.error.issues;
  if (!issues.every((i: any) => i.code === "too_big" && i.origin === "string" && typeof i.maximum === "number")) return null;
  const copy = structuredClone(input) as any;
  const trimmed: string[] = [];
  for (const i of issues as any[]) {
    let cur = copy;
    for (const k of i.path.slice(0, -1)) cur = cur?.[k];
    const last = i.path[i.path.length - 1];
    if (cur && typeof cur[last] === "string") {
      cur[last] = cur[last].slice(0, Math.max(0, i.maximum - 1)).trimEnd() + "…";
      trimmed.push(i.path.join("."));
    }
  }
  const again = schema.safeParse(copy);
  return again.success ? { data: again.data, trimmed } : null;
}
export const LOOP_STOP = 5;

export interface ApprovalRequest {
  agent: string;
  run_id: string;
  tool: string;
  input: unknown;
}
export type Approver = (req: ApprovalRequest) => Promise<boolean>;
export const denyAll: Approver = async () => false;

export interface RunOptions {
  task: string;
  provider: Provider;
  naive: NaiveClient | null;
  approver?: Approver;
  runCapUsd?: number;
  runsDir?: string;
  runId?: string;
  log?: (line: string) => void;
  /** Earlier turns of a conversation, oldest first; `task` is then the newest user message (chat). */
  history?: Message[];
  /** Called for every transcript event as it is written (type + data). Errors in it never stop the run. */
  onEvent?: (type: string, data: Record<string, unknown>) => void;
  /** Continue a crashed run under the same run id, workspace and spend. Built by resumeRun(). */
  resume?: ResumeState;
  /** Heartbeat refresh interval for run.json liveness (default 60 s; also refreshed per turn). */
  heartbeatMs?: number;
  /** Studio board for board_* tools, when this run should reach it (the dispatcher passes one). */
  board?: Board;
}

/** State carried over from a crashed run; only runner/resume.ts builds one. */
export interface ResumeState {
  runId: string;
  /** The run's original started_at, kept across resumes. */
  startedAt: string;
  /** The exact message list rebuilt from transcript.jsonl, including the interrupted-turn repair. */
  messages: Message[];
  turns: number;
  spentMicroUsd: number;
  /** Most expensive model call before the crash; the pre-flight budget estimate continues from it. */
  maxCallCost: number;
  wrapUp: boolean;
  /** Why the run was considered dead (from liveness.ts). */
  reason: string;
}

export interface RunResult {
  run_id: string;
  dir: string;
  status: RunStatus;
  output: unknown;
  spent_micro_usd: number;
  turns: number;
  error?: string;
}

export async function runAgent(spec: AgentSpec, opts: RunOptions): Promise<RunResult> {
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const rs = opts.resume;
  const runId = rs?.runId ?? opts.runId ?? `${stamp()}-${spec.name}`;
  const dir = path.join(runsDir, runId);
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const log = opts.log ?? (() => {});
  const approver = opts.approver ?? denyAll;
  const ledger = new SpendLedger(path.join(runsDir, "spend.jsonl"));
  // On resume the ledger already holds this run's earlier spend; the period/day caps count it,
  // and headroom() subtracts state.spent_micro_usd again — add it back exactly once.
  const limits = (() => {
    const base = limitsFor(spec, ledger, opts.runCapUsd);
    return rs
      ? { ...base, agent_period_left: base.agent_period_left + rs.spentMicroUsd, global_day_left: base.global_day_left + rs.spentMicroUsd }
      : base;
  })();
  const schema = outputJsonSchema(spec);
  const tools = toolDefs(spec, schema);
  const ctx: ToolContext = { workspace, naive: opts.naive, agent: spec.name, run_id: runId, runsDir, board: opts.board };

  const transcript = path.join(dir, "transcript.jsonl");
  const event = (type: string, data: Record<string, unknown>) => {
    appendFileSync(transcript, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
    try { opts.onEvent?.(type, data); } catch { /* a listener must never break the run */ }
  };

  const state: RunResult & Record<string, unknown> = {
    run_id: runId, dir, status: "running", output: null,
    spent_micro_usd: rs?.spentMicroUsd ?? 0, turns: rs?.turns ?? 0,
    pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString(),
  };
  const meta = {
    agent: spec.name, spec_hash: specHash(spec), provider: opts.provider.label, task: opts.task,
    limits, started_at: rs?.startedAt ?? new Date().toISOString(),
  };
  const saveRun = () => writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...meta, ...state, dir: undefined }, null, 2));
  /** Liveness: run.json is what `runs orphans` reads; refreshed per turn AND on a timer, so a
 *  stale heartbeat really means the process is gone even during a long tool call or approval wait. */
  const beat = () => {
    state.heartbeat_at = new Date().toISOString();
    saveRun();
  };
  saveRun();
  const heartbeat = setInterval(beat, opts.heartbeatMs ?? 60_000);
  heartbeat.unref?.(); // the run's own lifecycle decides when the process exits, not this timer
  if (rs) event("resume", { from_turn: rs.turns, reason: rs.reason, spent_micro_usd: rs.spentMicroUsd });
  else event("start", { ...meta, system: spec.system, tools: tools.map((t) => t.name), history: opts.history ?? [] });

  let maxCallCost = rs?.maxCallCost ?? 0;
  const charge = (kind: "model" | "tool", what: string, micro: number) => {
    if (!micro) return;
    state.spent_micro_usd += micro;
    ledger.append({ ts: new Date().toISOString(), run_id: runId, agent: spec.name, kind, what, micro_usd: micro });
  };
  // Remaining headroom across all three caps. Pre-flight: refuse a call that could exceed it,
  // estimated as the most expensive call so far (deterministic, conservative after turn 1).
  const headroom = () =>
    Math.min(limits.run_cap - state.spent_micro_usd, limits.agent_period_left - state.spent_micro_usd, limits.global_day_left - state.spent_micro_usd);
  const stop = (status: RunStatus, error?: string) => {
    state.status = status;
    if (error) state.error = error;
  };

  const system = systemPrompt(spec, schema !== null);
  // A resumed run rebuilds the exact message list from its transcript (runner/resume.ts);
  // nudges and loop-guard counters start fresh — max_turns still bounds the total.
  const messages: Message[] = rs ? [...rs.messages] : [...(opts.history ?? []), { role: "user", content: opts.task }];
  let nudges = 0;
  let lastFailKey = "";
  let repeats = 0;
  let wrapUp = rs?.wrapUp ?? false;
  /** Record every message exactly as the model saw it, so a crashed run can be rebuilt verbatim. */
  const pushMsg = (role: "user" | "assistant", content: string | Block[]) => {
    messages.push({ role, content });
    event("msg", { role, content });
  };
  /** Add a runtime note to the last user turn (keeps user/assistant turns alternating). */
  const noteToLastUser = (text: string) => {
    event("note", { text });
    const last = messages[messages.length - 1];
    if (last?.role !== "user") messages.push({ role: "user", content: text });
    else if (typeof last.content === "string") last.content += "\n\n" + text;
    else last.content.push({ type: "text", text });
  };

  try {
    while (state.status === "running") {
      beat();
      if (killSwitchOn(runsDir)) { stop("killed", "kill switch is on"); break; }
      if (state.turns >= spec.limits.max_turns) { stop("max_turns"); break; }
      if (schema && !wrapUp && state.turns > 0 && (state.spent_micro_usd >= WRAP_UP_SPENT * limits.run_cap || headroom() < WRAP_UP_CALLS * maxCallCost || state.turns >= spec.limits.max_turns - 2)) {
        wrapUp = true;
        const why = state.turns >= spec.limits.max_turns - 2 ? "turns" : "budget";
        event("wrap_up", { turn: state.turns, why, headroom: headroom(), max_call: maxCallCost });
        log(`wrap-up: nearly out of ${why}; only ${SUBMIT} is available now`);
        noteToLastUser(`Runtime: you are nearly out of ${why}. Stop researching and call ${SUBMIT} now with the best result you have from what you've already gathered. Keep it concise. Calls to any other tool will be rejected.`);
      }
      if (headroom() <= 0 || headroom() < maxCallCost) {
        stop("budget_exceeded", `headroom ${headroom()} micro-USD < next-call estimate ${maxCallCost}`);
        break;
      }
      state.turns++;
      event("request", { turn: state.turns, messages: messages.length });
      // Image refs become base64 only here, on the wire: the transcript and any resume keep refs.
      const reply = await opts.provider.complete({ system, messages: wireMessages(messages), tools, max_tokens: spec.limits.max_output_tokens });
      maxCallCost = Math.max(maxCallCost, reply.cost_micro_usd);
      charge("model", reply.model, reply.cost_micro_usd);
      event("reply", { turn: state.turns, ...reply });
      beat();
      log(`turn ${state.turns}: ${summarize(reply.content)} ($${(reply.cost_micro_usd / 1e6).toFixed(5)})`);
      pushMsg("assistant", reply.content.length ? reply.content : [{ type: "text", text: "" }]);

      const uses = reply.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        if (!schema) {
          state.output = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
          stop("done");
        } else if (nudges++ < MAX_NUDGES) {
          // A reply truncated by max_tokens arrives empty and the model tends to re-emit the
          // same oversized answer; tell it what happened instead of a generic nudge.
          const why =
            reply.stop_reason === "max_tokens"
              ? `Your last reply hit the ${spec.limits.max_output_tokens}-token output limit and was discarded whole; nothing in it ran. Do not repeat it. Work in small turns: one tool call at a time (write each file separately), then call ${SUBMIT} with a compact result.`
              : `You must finish by calling the ${SUBMIT} tool with your result.`;
          pushMsg("user", why);
        } else {
          stop("error", `agent ended without calling ${SUBMIT}`);
        }
        continue;
      }

      const results: ToolResultBlock[] = [];
      let stuck = false;
      for (const use of uses) {
        if (use.name === SUBMIT && schema) {
          let parsed: { success: boolean; data?: unknown; error?: any } = spec.output_schema!.safeParse(use.input);
          if (!parsed.success) {
            const s = salvageTooLong(spec.output_schema!, use.input);
            if (s) {
              event("salvage", { trimmed: s.trimmed });
              log(`salvaged submission: trimmed ${s.trimmed.join(", ")}`);
              parsed = { success: true, data: s.data };
            }
          }
          if (parsed.success) {
            state.output = parsed.data;
            if (spec.postprocess) {
              writeFileSync(path.join(dir, "output.raw.json"), JSON.stringify(parsed.data, null, 2));
              state.output = await spec.postprocess(parsed.data);
              event("postprocess", { ok: true });
            }
            event("submit", { ok: true });
            results.push({ type: "tool_result", tool_use_id: use.id, content: "accepted" });
            stop("done");
          } else {
            const why = parsed.error!.issues.map((i: any) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
            event("submit", { ok: false, why });
            // Keep the work even if there's no budget left to fix it.
            writeFileSync(path.join(dir, "rejected_output.json"), JSON.stringify({ why, input: use.input }, null, 2));
            results.push({ type: "tool_result", tool_use_id: use.id, content: `rejected, fix and resubmit: ${why}`, is_error: true });
          }
          continue;
        }
        const res = wrapUp
          ? { type: "tool_result" as const, tool_use_id: use.id, content: `wrap-up: only ${SUBMIT} is available now`, is_error: true }
          : await callTool(spec, use, ctx, approver, runId, event, charge);
        const key = use.name + JSON.stringify(use.input);
        if (res.is_error) {
          repeats = key === lastFailKey ? repeats + 1 : 1;
          lastFailKey = key;
          if (repeats >= LOOP_STOP) stuck = true;
          else if (repeats >= LOOP_WARN) {
            res.content = `You have made this exact failing call ${repeats} times. Do not repeat it: change the arguments, use a different tool, or move on.\n${res.content}`;
          }
        } else if (key === lastFailKey) {
          lastFailKey = "";
          repeats = 0;
        }
        results.push(res);
      }
      if (stuck) {
        stop("stuck", `repeated the same failing call ${LOOP_STOP} times: ${lastFailKey.slice(0, 200)}`);
        break;
      }
      pushMsg("user", results);
      if (state.status === "running" && headroom() <= 0) stop("budget_exceeded", "tool spend used the remaining budget");
    }
  } catch (e: any) {
    stop("error", String(e?.stack ?? e?.message ?? e));
    log(`error: ${e?.message ?? e}`);
  }

  if (state.output !== null) writeFileSync(path.join(dir, "output.json"), JSON.stringify(state.output, null, 2));
  clearInterval(heartbeat);
  Object.assign(state, { finished_at: new Date().toISOString() });
  saveRun();
  event("end", { status: state.status, spent_micro_usd: state.spent_micro_usd, turns: state.turns, error: state.error });
  return { run_id: runId, dir, status: state.status, output: state.output, spent_micro_usd: state.spent_micro_usd, turns: state.turns, error: state.error };
}

async function callTool(
  spec: AgentSpec,
  use: ToolUseBlock,
  ctx: ToolContext,
  approver: Approver,
  runId: string,
  event: (t: string, d: Record<string, unknown>) => void,
  charge: (k: "model" | "tool", w: string, m: number) => void,
): Promise<ToolResultBlock> {
  const err = (content: string): ToolResultBlock => {
    event("tool", { id: use.id, name: use.name, input: use.input, error: content });
    return { type: "tool_result", tool_use_id: use.id, content, is_error: true };
  };
  const entry = TOOL_INDEX[use.name];
  const perm: Permission | undefined = entry ? spec.tools[entry.capability] : undefined;
  if (!entry || !perm || perm === "deny") return err(`tool "${use.name}" is not available to you`);
  const impl = entry.impl;
  const parsed = impl.input.safeParse(use.input);
  if (!parsed.success) return err(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (perm === "ask") {
    const ok = await approver({ agent: spec.name, run_id: runId, tool: use.name, input: parsed.data });
    event("approval", { name: use.name, input: parsed.data, approved: ok });
    if (!ok) return err("a human declined this action");
  }
  const t0 = Date.now();
  const out = await impl.run(parsed.data, ctx);
  charge("tool", use.name, out.cost_micro_usd ?? 0);
  // `clipped` tells resume.ts the recorded content is not the exact result anymore. An image
  // result records its ref block separately (small, no base64); the model gets text + image.
  const content = out.image ? [{ type: "text" as const, text: out.content }, out.image] : out.content;
  event("tool", { id: use.id, name: use.name, input: parsed.data, ms: Date.now() - t0, is_error: !!out.is_error, cost_micro_usd: out.cost_micro_usd ?? 0, content: clip(out.content, 100_000), clipped: out.content.length > 100_000, ...(out.image ? { image: out.image } : {}) });
  return { type: "tool_result", tool_use_id: use.id, content, ...(out.is_error ? { is_error: true } : {}) };
}

/**
 * Schemas sent to the model drop numeric bounds and carry them in the description instead.
 * Naïve's proxy (verified Nov 6 on z-ai/glm-5.3) turns `minimum: 0, maximum: 1` numbers into
 * integers: 0.65 arrives as 0. Zod still enforces the bounds when the result is validated.
 */
export function modelSafeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(modelSafeSchema);
  if (!node || typeof node !== "object") return node;
  const o: Record<string, unknown> = {};
  const bounds: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "minimum" || k === "exclusiveMinimum") bounds.push(`${k === "minimum" ? ">=" : ">"} ${v}`);
    else if (k === "maximum" || k === "exclusiveMaximum") bounds.push(`${k === "maximum" ? "<=" : "<"} ${v}`);
    else o[k] = modelSafeSchema(v);
  }
  // Huge safe-integer bounds from z.int() say nothing useful.
  const useful = bounds.filter((b) => !/9007199254740991/.test(b));
  if (useful.length) {
    const range = `Range: ${useful.join(" and ")}${o.type === "number" ? " (decimals allowed)" : ""}.`;
    o.description = o.description ? `${o.description} ${range}` : range;
  }
  return o;
}

function toolDefs(spec: AgentSpec, schema: Record<string, unknown> | null): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const [cap, perm] of Object.entries(spec.tools) as [CapabilityName, Permission][]) {
    if (perm === "deny") continue;
    for (const [name, impl] of Object.entries(IMPLS[cap])) {
      const { $schema: _s, ...raw } = z.toJSONSchema(impl.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      const input_schema = modelSafeSchema(raw) as Record<string, unknown>;
      defs.push({ name, description: impl.description + (perm === "ask" ? " (Needs human approval each call.)" : ""), input_schema });
    }
  }
  if (schema) {
    const { $schema: _s, ...raw } = schema;
    const input_schema = modelSafeSchema(raw) as Record<string, unknown>;
    defs.push({ name: SUBMIT, description: "Submit your final result. It is validated; fix and resubmit if rejected.", input_schema });
  }
  return defs;
}

function systemPrompt(spec: AgentSpec, structured: boolean): string {
  const footer = [
    "",
    "---",
    "Runtime notes (from the studio runner):",
    `- Today is ${new Date().toISOString().slice(0, 10)}.`,
    `- You have at most ${spec.limits.max_turns} turns and a budget of $${spec.budget.max_task_usd} for this task. Be efficient.`,
    structured ? `- Finish by calling ${SUBMIT} with your result. Plain-text answers are not accepted.` : "- Finish with your answer as plain text.",
  ];
  return spec.system + "\n" + footer.join("\n");
}

function summarize(content: Block[]): string {
  return content
    .map((b) => (b.type === "text" ? `text(${b.text.length})` : b.type === "tool_use" ? `${b.name}(${JSON.stringify(b.input).slice(0, 80)})` : b.type))
    .join(", ") || "(empty)";
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
