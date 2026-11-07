import { WEAVE_NOW, WEAVE_TZ, type InboxItem } from "./mock/weave";
import { studioTeams, workRuns, workTasks } from "./registry";
import { httpMode } from "./api";
import type { StudioTeam } from "@fabric/contracts";
import { isActive, stagesAt, type StageState } from "./run-state";
import { isAsk, weaveItems, type WeaveState } from "./weave-store";
import type { Run, Task } from "./types";
import { danaErrandOwner } from "./errand-owner";

/**
 * Work board columns. Teams have different workflows, so the project board uses stages every
 * team maps onto (Linear's status categories, in effect): before the review step, at it, and after.
 */
export type Column = "proposed" | "in_progress" | "in_review" | "done";
export const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: "proposed", label: "Proposed", hint: "The Studio Head proposed it. Nothing runs until you say yes." },
  { id: "in_progress", label: "In progress", hint: "A team is working through its steps." },
  { id: "in_review", label: "In review", hint: "At the team's review step, which can send work back." },
  { id: "done", label: "Done", hint: "Accepted, or stopped. Every loop can be replayed." },
];

export type Outcome = "accepted" | "caveat" | "stopped";
/** What a card's status pill says. */
export type LoopState = "proposed" | "running" | "review" | "blocked" | Outcome;

export interface TaskSummary {
  task: Task;
  team: StudioTeam;
  loops: Run[];
  latest?: Run;
  column: Column;
  /** The team step the work is in now. */
  stage?: string;
  stages: { label: string; state: StageState; gate?: boolean }[];
  /** Agents working right now, and agents waiting on you. */
  working: string[];
  waiting: string[];
  /** Open asks (approvals, questions, escalations) about this task, in Weave. */
  asks: InboxItem[];
  /** Dana's proposal, while it waits for your yes. */
  proposal?: InboxItem;
  outcome?: { kind: Outcome; text: string };
  /** A line that replaces the usual meta when a decision changed the card. */
  note?: string;
  reworkUsed: number;
  reworkBudget: number;
  startedAt?: string;
  endedAt?: string;
  etaAt?: string;
}

interface Override {
  column: Column;
  stage?: string;
  note?: string;
  working?: string[];
  reworkBudget?: number;
  outcome?: TaskSummary["outcome"];
}

/** How a decision in Weave moves a card. Keyed by Weave item, then the action you took. */
const DECISIONS: Record<string, Record<string, Override>> = {
  "handoff-product": {
    go: { column: "in_progress", stage: "Frame", working: ["diego"], note: "Handed off from Weave. Diego is framing the bet." },
  },
  "nand-budget": {
    raise: { column: "in_progress", stage: "Plan", working: ["elliot"], reworkBudget: 3, note: "Budget raised to 3. Elliot is re-planning the harness." },
    caveat: { column: "done", outcome: { kind: "caveat", text: "Accepted with the caveat “timing not validated”." } },
    stop: { column: "done", outcome: { kind: "stopped", text: "Stopped by you. Its artifacts are kept." } },
  },
};

export const addSeconds = (iso: string, s: number) => new Date(new Date(iso).getTime() + s * 1000).toISOString();
export const teamById = (id: string) => id === "dana" ? danaErrandOwner : studioTeams().find((t) => t.id === id)!;
/** The explicit lead, else the first member (teams from the studio's agent specs have no lead). */
export const leadOf = (team: StudioTeam) => (team.members.find((m) => m.lead) ?? team.members[0]).agentId;
export const reworkOf = (run: Run) => run.segments.filter((s) => s.kind === "bounce").length;

export function summarize(task: Task, runs: Run[], weave: WeaveState): TaskSummary {
  const team = teamById(task.teamId);
  const loops = task.runIds.map((id) => runs.find((r) => r.id === id)).filter((r): r is Run => !!r);
  const latest = loops[loops.length - 1];
  const items = weaveItems().filter((i) => i.taskId === task.id);
  const open = (i: InboxItem) => weave.status[i.id]?.status === "open";
  const proposal = task.proposal && items.find((i) => i.id === task.proposal!.itemId && open(i));

  const s: TaskSummary = {
    task, team, loops, latest,
    column: "proposed",
    stages: team.workflow.map((w) => ({ label: w.label, state: "pending" as StageState, gate: w.gate })),
    working: [], waiting: [],
    asks: items.filter((i) => isAsk(i) && open(i)),
    proposal,
    reworkUsed: latest ? reworkOf(latest) : 0,
    reworkBudget: latest?.reworkBudget ?? team.reworkBudget,
    startedAt: latest?.startedAt,
  };

  if (latest) {
    const now = latest.durationS;
    const { stages, currentStage } = stagesAt(latest, team, now);
    s.stages = stages;
    s.stage = currentStage;
    const active = latest.segments.filter((x) => isActive(latest, x, now));
    s.working = [...new Set(active.filter((x) => x.kind === "work" || x.kind === "rework").map((x) => x.agentId))];
    s.waiting = [...new Set(active.filter((x) => x.kind === "wait").map((x) => x.agentId))];
    if (latest.status === "accepted" || latest.status === "stopped") {
      s.column = "done";
      s.outcome = { kind: latest.status === "accepted" ? "accepted" : "stopped", text: latest.outcome ?? "" };
      s.endedAt = addSeconds(latest.startedAt, latest.durationS);
    } else {
      s.column = team.workflow.find((w) => w.label === currentStage)?.gate ? "in_review" : "in_progress";
      if (latest.etaS) s.etaAt = addSeconds(latest.startedAt, latest.etaS);
    }
  }

  // A decision you made in Weave moves the card on.
  for (const item of items) {
    const st = weave.status[item.id];
    const o = st?.status === "done" && st.actionId ? DECISIONS[item.id]?.[st.actionId] : undefined;
    if (!o) continue;
    s.column = o.column;
    s.note = o.note;
    s.outcome = o.outcome ?? s.outcome;
    s.reworkBudget = o.reworkBudget ?? s.reworkBudget;
    s.waiting = [];
    if (o.working) s.working = o.working;
    if (o.column === "done") s.endedAt = st.doneAt;
    if (o.stage) {
      const at = team.workflow.findIndex((w) => w.label === o.stage);
      s.stage = o.stage;
      s.stages = s.stages.map((x, i) => ({ ...x, state: i < at ? "done" : i === at ? "active" : "pending" }));
    } else if (o.column === "done") {
      s.stages = s.stages.map((x) => ({ ...x, state: x.state === "waiting" || x.state === "active" ? "earlier" : x.state }));
    }
  }
  return s;
}

export function loopState(s: TaskSummary): LoopState {
  if (s.outcome) return s.outcome.kind;
  if (s.column === "proposed") return "proposed";
  if (s.latest?.status === "blocked" && !s.note) return "blocked";
  return s.column === "in_review" ? "review" : "running";
}

/** When a task last moved: its loop ending, its loop starting, or Dana proposing it. */
export const activityAt = (s: TaskSummary) => s.endedAt ?? s.startedAt ?? s.task.proposal?.at ?? "";
/** Asks plus a waiting proposal: everything on a task that needs you. */
export const waitingCount = (s: TaskSummary) => s.asks.length + (s.proposal ? 1 : 0);

/** Cards that need you go first, then the most recent. */
export function byUrgency(a: TaskSummary, b: TaskSummary) {
  const needs = (x: TaskSummary) => (waitingCount(x) ? 0 : 1);
  return needs(a) - needs(b) || activityAt(b).localeCompare(activityAt(a));
}

/** Finished loops, newest first: every earlier loop of a task plus the last one once it's done. */
export function previousLoops(summaries: TaskSummary[]) {
  return summaries.flatMap((s) => s.loops.flatMap((run) => {
    const isLatest = run === s.latest;
    if (isLatest && s.column !== "done") return [];
    const outcome: Outcome = isLatest && s.outcome ? s.outcome.kind : run.status === "accepted" ? "accepted" : "stopped";
    const endedAt = isLatest && s.endedAt ? s.endedAt : addSeconds(run.startedAt, run.durationS);
    return [{ run, summary: s, outcome, endedAt }];
  })).sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}
export type PreviousLoop = ReturnType<typeof previousLoops>[number];

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: WEAVE_TZ, hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: WEAVE_TZ, month: "short", day: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: WEAVE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "9:05 AM" today, "Sep 29" otherwise. HTTP uses the real clock for new results. */
export function when(iso: string) {
  const d = new Date(iso);
  return dayFmt.format(d) === dayFmt.format(httpMode ? new Date() : WEAVE_NOW) ? timeFmt.format(d) : dateFmt.format(d);
}
/** "Sep 29, 1:04 PM" or "today, 9:05 AM". */
export function whenFull(iso: string) {
  const d = new Date(iso);
  return `${dayFmt.format(d) === dayFmt.format(httpMode ? new Date() : WEAVE_NOW) ? "today" : dateFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** Loops across a team's tasks. Studio holds the definition; the instances live in Work. */
export const teamLoopCount = (teamId: string) => workTasks().filter((t) => t.teamId === teamId).reduce((n, t) => n + t.runIds.length, 0);

export function lastLoopAt(teamId: string) {
  const ids = new Set(workTasks().filter((t) => t.teamId === teamId).flatMap((t) => t.runIds));
  const last = workRuns().filter((r) => ids.has(r.id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return last && when(last.startedAt);
}
