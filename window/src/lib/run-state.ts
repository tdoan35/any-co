import { studioTeams } from "./registry";
import type { StudioTeam } from "@fabric/contracts";
import type { Run, RunEvent, RunSegment } from "./types";
import { danaErrandOwner } from "./errand-owner";

export type MemberState = "idle" | "working" | "done" | "bounced" | "rework" | "waiting" | "blocked";

export interface MemberView {
  agentId: string;
  state: MemberState;
  currentLabel?: string;
  lines: { t: number; text: string; kind: "term" | "msg" }[];
}

/**
 * A workflow step at time t. `earlier` = done in a previous pass, before the latest bounce;
 * `skipped` = never used, though a later step has started;
 * `bounced` = the gate sent the work back; `waiting` = someone in this step is waiting on you.
 */
export type StageState = "pending" | "skipped" | "active" | "done" | "earlier" | "bounced" | "waiting";

export interface Verdict { verdict: "accept" | "request_changes"; text: string; t: number; by?: string }
export interface CriterionView { state: "pending" | "pass" | "fail"; note?: string; t?: number; by?: string }

export interface RunView {
  members: MemberView[];
  stages: { label: string; state: StageState; gate?: boolean }[];
  currentStage: string;
  reworkUsed: number;
  verdicts: Verdict[];
  criteria: CriterionView[];
  denied: { tool: string; target: string; reason: string; t: number; by?: string }[];
  artifacts: { name: string; by?: string; t: number }[];
  blocked?: { reason: string; t: number };
  stopped?: { text: string; t: number };
  finished: boolean;
}

export const teamOf = (run: Pick<Run, "teamId">): StudioTeam => run.teamId === "dana" ? danaErrandOwner : studioTeams().find((t) => t.id === run.teamId)!;

/** Running and blocked loops end at "now": a segment that reaches it is still going. */
const isOpen = (run: Run, s: RunSegment) => (run.status === "running" || run.status === "blocked") && s.end >= run.durationS;
export const isActive = (run: Run, s: RunSegment, t: number) => s.start <= t && (t < s.end || (isOpen(run, s) && t >= s.end));

const MEMBER_STATE: Record<RunSegment["kind"], MemberState> = { work: "working", rework: "rework", bounce: "bounced", wait: "waiting", blocked: "blocked" };

/** Step states from segments alone, so the board can call it without the event log. */
export function stagesAt(run: Run, team: StudioTeam, t: number) {
  const started = run.segments.filter((s) => s.start <= t);
  // A new pass starts when the last bounce hands the work back.
  const passStart = Math.max(0, ...started.filter((s) => s.kind === "bounce" && s.end <= t).map((s) => s.end));
  const done = run.status === "accepted" && t >= run.durationS;
  const stages = team.workflow.map((w): { label: string; state: StageState; gate?: boolean } => {
    const segs = started.filter((s) => s.stage === w.label).sort((a, b) => a.start - b.start);
    const active = segs.find((s) => isActive(run, s, t));
    const latest = segs[segs.length - 1];
    let state: StageState = "pending";
    if (active) state = active.kind === "bounce" ? "bounced" : active.kind === "wait" ? "waiting" : "active";
    else if (latest?.kind === "bounce") state = "bounced";
    else if (segs.some((s) => s.start >= passStart)) state = "done";
    else if (segs.length) state = done ? "done" : "earlier";
    return { label: w.label, state, gate: w.gate };
  });
  const order = (label: string) => team.workflow.findIndex((w) => w.label === label);
  const furthest = Math.max(-1, ...started.map((s) => order(s.stage)));
  stages.forEach((s, i) => { if (s.state === "pending" && i < furthest) s.state = "skipped"; });
  const active = started.filter((s) => isActive(run, s, t)).sort((a, b) => order(b.stage) - order(a.stage))[0];
  const latest = [...started].sort((a, b) => b.start - a.start)[0];
  return { stages, currentStage: (active ?? latest)?.stage ?? team.workflow[0].label };
}

/** Pure projection of a loop's event log at time t. Live and replay both use this. */
export function projectRun(run: Run, events: RunEvent[], t: number): RunView {
  const team = teamOf(run);
  const seen = events.filter((e) => e.t <= t);
  const members: MemberView[] = team.members.map(({ agentId }) => {
    const segs = run.segments.filter((s) => s.agentId === agentId);
    const active = segs.find((s) => isActive(run, s, t));
    const past = segs.filter((s) => s.end <= t);
    const state: MemberState = active ? MEMBER_STATE[active.kind] : past.length && past.length === segs.length ? "done" : "idle";
    return {
      agentId,
      state,
      currentLabel: active?.label,
      lines: seen
        .filter((e) => e.actorAgentId === agentId && (e.type === "agent.message" || e.type === "tool.result"))
        .map((e) => e.type === "agent.message"
          ? { t: e.t, text: String(e.payload.text), kind: "msg" as const }
          : { t: e.t, text: String(e.payload.line), kind: (e.payload.kind as "term" | "msg") ?? "term" }),
    };
  });
  const criteria: CriterionView[] = run.brief.criteria.map((_, i) => {
    const last = seen.filter((e) => e.type === "criterion.checked" && e.payload.index === i).pop();
    return last ? { state: last.payload.pass ? "pass" : "fail", note: String(last.payload.note), t: last.t, by: last.actorAgentId } : { state: "pending" };
  });
  const blocked = seen.find((e) => e.type === "run.blocked");
  const stopped = seen.find((e) => e.type === "run.stopped");
  const finished = seen.some((e) => e.type === "run.finished");
  return {
    members,
    ...stagesAt(run, team, t),
    reworkUsed: seen.filter((e) => e.type === "rework.requested").length,
    verdicts: seen.filter((e) => e.type === "review.verdict").map((e) => ({
      verdict: e.payload.verdict as Verdict["verdict"], text: String(e.payload.text), t: e.t, by: e.actorAgentId,
    })),
    criteria,
    denied: seen.filter((e) => e.type === "tool.denied").map((e) => ({
      tool: String(e.payload.tool), target: String(e.payload.target), reason: String(e.payload.reason), t: e.t, by: e.actorAgentId,
    })),
    artifacts: seen.filter((e) => e.type === "artifact.created").map((e) => ({ name: String(e.payload.name), by: e.actorAgentId, t: e.t })),
    blocked: blocked && { reason: String(blocked.payload.reason), t: blocked.t },
    stopped: stopped && { text: String(stopped.payload.text), t: stopped.t },
    finished,
  };
}

export interface RunMarker { t: number; kind: "bounce" | "accept" | "artifact" | "denied" | "blocked"; label: string }

/** Moments worth jumping to on the scrubber. Fast playback pauses on verdicts. */
export function runMarkers(events: RunEvent[]): RunMarker[] {
  return events.flatMap((e): RunMarker[] => {
    if (e.type === "review.verdict") {
      const accept = e.payload.verdict === "accept";
      return [{ t: e.t, kind: accept ? "accept" : "bounce", label: accept ? "Accepted" : "Changes requested" }];
    }
    if (e.type === "artifact.created") return [{ t: e.t, kind: "artifact", label: String(e.payload.name) }];
    if (e.type === "tool.denied") return [{ t: e.t, kind: "denied", label: `Blocked ${String(e.payload.tool)}` }];
    if (e.type === "run.blocked") return [{ t: e.t, kind: "blocked", label: String(e.payload.reason) }];
    return [];
  });
}

export function fmtClock(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h === 0 && m === 0) return `${sec}s`;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** "3h 12m", "45m": durations without seconds. */
export function fmtSpan(s: number) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Grows with the clock during the live start, so the first minute is legible; replay shows the whole loop. */
export function laneDomain(run: Run, t: number, liveStart: boolean) {
  if (!liveStart) return run.etaS ?? run.durationS;
  const want = Math.max(60, t * 1.25);
  const step = [15, 30, 60, 120, 300, 600, 900, 1800].find((s) => s * 4 >= want);
  return step ? step * 4 : Math.ceil(want / 3600) * 3600;
}
