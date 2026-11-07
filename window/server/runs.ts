// Maps the local runner's output (runs/<run_id>/transcript.jsonl) onto the Fabric contracts the UI reads:
// one runner run = one Task with one Run (loop), and its transcript becomes RunEvents.
// Pure functions only; reading the disk lives in index.ts. Never writes anything.
import type { Run, RunEvent, RunSegment, RunStatus, Task } from "@fabric/contracts";

/** The runner has no wall-clock budget; the UI wants one for its time meter. Display allowance only. */
export const RUN_TIME_BUDGET_S = 900;
/** A run with no `end` line and no activity for this long is treated as dead, not running. */
export const STALE_MS = 10 * 60_000;
export const STAGE = "Work";

export type TranscriptLine = { ts: string; type: string; [key: string]: unknown };

export interface MappedRun { run: Run; task: Task; events: RunEvent[]; agent: string; lastTs: number; chat: boolean }

/** Chat turns are ordinary runs named `<stamp>-<agent>-t<turn>-<session4>` (chat.ts). They stay on the Work page
 * as "Chat: …" tasks but are kept out of the Weave pulse and summary. Mirrored in src/components/weave/pulse.tsx. */
export const CHAT_RUN_ID = /-t\d+-[a-z0-9]{4}$/;
export const CHAT_TASK_PREFIX = "Chat: ";

const str = (v: unknown, max = 400) => String(v ?? "").slice(0, max);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Parse transcript.jsonl text; skips blank or torn lines (the file is appended while we read it). */
export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw) as TranscriptLine;
      if (o && typeof o.type === "string" && typeof o.ts === "string" && !Number.isNaN(Date.parse(o.ts))) out.push(o);
    } catch { /* torn last line */ }
  }
  return out;
}

const END_STATUS: Record<string, RunStatus> = {
  done: "accepted",
  budget_exceeded: "blocked",
  max_turns: "stopped",
  stuck: "stopped",
  killed: "stopped",
  error: "stopped",
};

export const teamIdOf = (dept: string) => `team-${dept}`;

/** Returns undefined when the transcript has no `start` line yet (run dir just created). */
export function mapRun(
  id: string,
  lines: TranscriptLine[],
  deptOf: (agent: string) => string,
  now = Date.now(),
): MappedRun | undefined {
  const start = lines.find((l) => l.type === "start");
  if (!start) return undefined;
  const agent = str(start.agent, 80);
  const t0 = Date.parse(start.ts);
  const at = (l: TranscriptLine) => round(Math.max(0, (Date.parse(l.ts) - t0) / 1000));
  const events: RunEvent[] = [];
  const push = (l: TranscriptLine, type: RunEvent["type"], payload: Record<string, unknown>) =>
    events.push({ runId: id, seq: events.length, t: at(l), type, actorAgentId: agent, payload });

  const segments: RunSegment[] = [];
  let openStep: { label: string; start: number } | undefined;
  const closeStep = (l: TranscriptLine) => {
    if (!openStep) return;
    push(l, "step.finished", { label: openStep.label, stage: STAGE, kind: "work" });
    segments.push({ agentId: agent, label: openStep.label, stage: STAGE, start: openStep.start, end: at(l), kind: "work" });
    openStep = undefined;
  };

  let costMicro = 0;
  let firstInputTokens = 0;
  let end: TranscriptLine | undefined;
  for (const l of lines) {
    switch (l.type) {
      case "start":
        push(l, "run.started", { objective: str(l.task, 2000) });
        break;
      case "request": {
        closeStep(l);
        const label = `Turn ${str(l.turn, 8)}`;
        openStep = { label, start: at(l) };
        push(l, "step.started", { label, stage: STAGE, kind: "work" });
        break;
      }
      case "reply": {
        costMicro += num(l.cost_micro_usd);
        const usage = l.usage as { input_tokens?: number } | undefined;
        if (!firstInputTokens) firstInputTokens = num(usage?.input_tokens);
        for (const b of Array.isArray(l.content) ? (l.content as Array<Record<string, unknown>>) : []) {
          if (b.type === "text" && str(b.text).trim()) push(l, "agent.message", { text: str(b.text, 4000) });
          else if (b.type === "tool_use") push(l, "tool.call", { tool: str(b.name, 80), summary: str(JSON.stringify(b.input ?? {}), 300) });
        }
        push(l, "budget.update", { costUsd: round(costMicro / 1e6, 6) });
        break;
      }
      case "tool": {
        costMicro += num(l.cost_micro_usd);
        const prefix = l.is_error ? "error: " : "";
        const body = str(l.content, 2000).split("\n").filter((s) => s.trim()).slice(0, 8);
        for (const line of body.length ? body : [`${str(l.name)} (no output)`]) {
          push(l, "tool.result", { line: prefix + line.slice(0, 200), kind: "term" });
        }
        break;
      }
      case "approval": {
        const ok = l.approved === true;
        push(l, "tool.result", { line: `approval for ${str(l.name, 80)}: ${ok ? "granted" : "denied"}`, kind: "term" });
        if (!ok) push(l, "tool.denied", { tool: str(l.name, 80), target: str(JSON.stringify(l.input ?? {}), 200), reason: "approval denied" });
        break;
      }
      case "submit":
        if (l.ok) push(l, "artifact.created", { name: "result" });
        else push(l, "tool.result", { line: "submit_result rejected; agent must fix and resubmit", kind: "term" });
        break;
      case "wrap_up": // the runner told the agent to submit now (budget or turns nearly spent)
        push(l, "tool.result", { line: `wrap-up: ${str(l.why, 120)}; the agent was told to submit now`, kind: "term" });
        break;
      case "end":
        end = l;
        break;
    }
  }

  const lastLine = lines[lines.length - 1];
  const lastTs = Date.parse(lastLine.ts);
  let status: RunStatus;
  let outcome: string | undefined;
  if (end) {
    closeStep(end);
    const raw = str(end.status, 40);
    status = END_STATUS[raw] ?? "stopped";
    outcome = raw === "done" ? "Finished" : `Ended: ${raw}${end.error ? ` (${str(end.error, 200)})` : ""}`;
    if (status === "accepted") push(end, "run.finished", {});
    else if (status === "blocked") push(end, "run.blocked", { reason: outcome });
    else push(end, "run.stopped", { by: "runner", text: outcome });
  } else if (now - lastTs > STALE_MS) {
    status = "stopped";
    outcome = "No activity and no end record; the runner probably died.";
    closeStep(lastLine);
    push(lastLine, "run.stopped", { by: "runner", text: outcome });
  } else {
    status = "running";
  }

  const nowS = round(Math.max(0, (now - t0) / 1000));
  if (openStep) segments.push({ agentId: agent, label: openStep.label, stage: STAGE, start: openStep.start, end: nowS, kind: "work" });
  const durationS = status === "running" ? nowS : at(end ?? lastLine);
  const limits = (start.limits ?? {}) as { run_cap?: number };
  const spent = end ? num(end.spent_micro_usd) || costMicro : costMicro;
  const objective = str(start.task, 4000);
  const taskId = `task-${id}`;

  const run: Run = {
    id,
    taskId,
    teamId: teamIdOf(deptOf(agent)),
    n: 1,
    objective,
    status,
    startedAt: start.ts,
    recorded: false,
    durationS,
    costUsd: round(spent / 1e6, 6),
    budget: { costUsd: round(num(limits.run_cap) / 1e6, 6), timeS: RUN_TIME_BUDGET_S },
    reworkBudget: 0,
    assistantTokens: 0,
    brief: { tokens: firstInputTokens, objective, constraints: [], criteria: [], preferences: [], stayed: [] },
    segments,
    ...(outcome ? { outcome } : {}),
  };
  const chat = CHAT_RUN_ID.test(id);
  const title = (chat ? CHAT_TASK_PREFIX : "") + titleOf(objective, agent);
  const task: Task = { id: taskId, projectId: STUDIO_PROJECT_ID, teamId: run.teamId, title, runIds: [id] };
  return { run, task, events, agent, lastTs, chat };
}

export const STUDIO_PROJECT_ID = "studio";

/** First non-empty line of the objective, cut at a word boundary. */
export function titleOf(objective: string, fallback: string, max = 70): string {
  const first = objective.split("\n").find((l) => l.trim())?.trim() ?? fallback;
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20))}…`;
}
