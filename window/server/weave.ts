// Weave snapshot from run state. There is no approval ledger or Studio Head inbox yet, so `items`
// is empty; presence and the pulse come from the runs. Wire real items in when the ledger exists.
import type { EventEntry, Presence, WeaveSnapshot } from "@fabric/contracts";
import type { MappedRun } from "./runs.ts";

const PULSE_LIMIT = 60;

export function buildWeave(runs: MappedRun[], agentIds: string[]): WeaveSnapshot {
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
  return { items: [], pulse: pulse.slice(-PULSE_LIMIT).reverse(), presence: [...presence.values()], calendar: [] };
}
