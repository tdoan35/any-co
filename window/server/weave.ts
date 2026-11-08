// Weave snapshot from run state. `items` lists the pending approval requests (runs/approvals.jsonl,
// written by the approval gate every `ask` tool call) as read-only display: deciding happens in the
// terminal (`npm run approvals`), because chat with the Studio Head is the window's only write path.
// Requests whose run finished or is orphaned are hidden (the window never writes the expiry itself;
// `approvals list`/`approve`/`deny` and resume do, ledgered as who "run ended").
// Board cards are read-only here too: a doing card shows its assignee at work (presence), a blocked
// card is studio news (pulse) and marks its holder blocked when no run already shows them busy.
import type { EventEntry, Presence, WeaveSnapshot } from "@fabric/contracts";
import type { MappedRun } from "./runs.ts";
import { PROJECT } from "./registry.ts";
import { APPROVALS_FILE, pendingLive } from "../../tools/approvals/approvals.ts";
import type { BoardCard } from "../../runner/board/types.ts";

const PULSE_LIMIT = 60;

export function buildWeave(runs: MappedRun[], agentIds: string[], approvalsFile = APPROVALS_FILE, runsDir?: string, boardCards: BoardCard[] = []): WeaveSnapshot {
  const presence = new Map<string, Presence>();
  for (const id of agentIds) presence.set(id, { agentId: id, state: "idle", activity: "Idle", since: new Date(0).toISOString() });

  const pulse: EventEntry[] = [];
  for (const { run, task, events, agent, lastTs, chat } of [...runs].sort((a, b) => Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt))) {
    if (chat && run.status !== "running") continue; // a finished chat turn is conversation, not studio news
    if (chat) { presence.set(agent, { agentId: agent, state: "working", activity: "Answering a chat message", since: new Date(lastTs).toISOString() }); continue; }
    pulse.push({ id: `${run.id}:start`, kind: "event", at: run.startedAt, actorId: agent, text: `Started: ${task.title}` });
    if (run.status !== "running") {
      const endAt = new Date(Date.parse(run.startedAt) + run.durationS * 1000).toISOString();
      pulse.push({ id: `${run.id}:end`, kind: "event", at: endAt, actorId: agent, text: run.outcome ?? run.status });
    } else {
      const lastCall = [...events].reverse().find((e) => e.type === "tool.call");
      presence.set(agent, {
        agentId: agent,
        state: "working",
        activity: `${run.segments.at(-1)?.label ?? "Starting"}${lastCall ? ` · ${String(lastCall.payload.tool)}` : ""}`,
        since: new Date(lastTs).toISOString(),
      });
    }
  }
  for (const card of boardCards) {
    if (card.status !== "doing" && card.status !== "blocked") continue;
    if (card.assignee && presence.get(card.assignee)?.state === "idle") {
      presence.set(card.assignee, {
        agentId: card.assignee,
        state: card.status === "doing" ? "working" : "blocked",
        activity: `${card.status === "doing" ? "Board" : "Blocked"} · ${card.title}`,
        since: card.updated_at,
      });
    }
    if (card.status === "blocked") {
      pulse.push({
        id: `board:${card.id}`,
        kind: "event",
        at: card.updated_at,
        actorId: card.assignee ?? "studio-head",
        text: `Blocked: ${card.title}${card.note ? ` — ${card.note.slice(0, 120)}` : ""}`,
      });
    }
  }
  const items = pendingLive(approvalsFile, runsDir).map((a) => ({
    id: a.id,
    kind: "approval" as const,
    agentId: a.agent,
    project: PROJECT.name,
    run: { label: a.run_id, href: `/runs/${a.run_id}` },
    title: `${a.agent} wants to run ${a.tool}`,
    brief: `${a.agent}'s ${a.tool}`,
    at: a.ts,
    why: "This tool is gated behind a human approval (AGENTS.md rule 4). Approve or deny from the terminal: npm run approvals",
    tool: a.tool,
    policy: "approval" as const,
    policyNote: "Asks before every call",
    preview: [
      { label: "Run", value: a.run_id },
      { label: "Input", value: JSON.stringify(a.input).slice(0, 200) },
    ],
    actions: [], // read-only: the window has no approval endpoint
  }));
  return { items, pulse: pulse.slice(-PULSE_LIMIT).reverse(), presence: [...presence.values()], calendar: [] };
}
