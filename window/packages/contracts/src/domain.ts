// Domain types shared by the web app and the server. Moved from apps/web/src/lib/types.ts.
// Fields added in contracts-v1 are optional where today's mock fixtures don't carry them yet;
// the server always sets them.

export type AgentStatus = "existing" | "new";

export type Disposition =
  | "handle_directly"
  | "delegate_agent"
  | "delegate_team"
  | "propose_team"
  | "propose_specialist"
  | "clarify";

/** Args of the `record_disposition` part. `considered` is stored, not rendered (CHAT-13). */
export interface DispositionArgs {
  disposition: Disposition;
  reason: string;
  considered?: string[];
}

export interface RosterEntry {
  /** Persona slug, e.g. "elliot". */
  agentId: string;
  name: string;
  status: AgentStatus;
  role?: string;
  avatar?: string;
}

/** A row on a proposal card: the default, and its one-line justification (PRODUCT §7). */
export interface ProposalRow {
  label: string;
  value: string;
  why: string;
}

export interface TeamProposal {
  kind: "team";
  name: string;
  purpose: string;
  roster: RosterEntry[];
  proposalId?: string;
  workflow?: { label: string; agentIds: string[]; gate?: boolean }[];
  reworkBudget?: number;
  criteria?: string[];
  /** Defaults for a new lead (CARD-1). */
  leadDefaults?: ProposalRow[];
  /** toolCallId of the card this one replaces (CARD-4). */
  supersedes?: string;
}

export interface SpecialistProposal {
  kind: "specialist";
  name: string;
  purpose: string;
  rows: ProposalRow[];
  proposalId?: string;
  /** The persona Dana picked from the pool, so nothing is renamed after approval (D1). */
  persona?: { id: string; name: string; role: string; avatar: string };
  supersedes?: string;
}

export type Proposal = TeamProposal | SpecialistProposal;
export type ProposalDecision = "approved" | "declined" | "discuss";
/** The human result a proposal card adds. */
export interface ProposalResult {
  decision: ProposalDecision;
}

export interface HandoffPayload {
  runId: string;
  teamName: string;
  summary: string;
  members: { name: string; state: string; agentId?: string; role?: string }[];
  taskId?: string;
}

/** Args of the `post_results` part: Dana's "I got the results" message (CHAT-14). */
export interface ResultsPayload {
  reportId: string;
  runId: string;
  taskId: string;
  title: string;
  summary: string;
  rows: Report["results"];
}

// ---- Work: projects hold tasks; a task's runs are its loops ----

export interface Project {
  id: string;
  name: string;
  /** What the project is trying to find out or ship. Shown on its Work board. */
  goal: string;
  /** Finished or shelved: kept for its history, off the sidebar and the project pickers. */
  archived?: boolean;
}

/**
 * One goal, owned by one team, inside one project: a card on the Work board.
 * Each run of it is a loop (UI word). A re-run after a stop is a new loop on the same task;
 * the reviewer's bounces stay inside one loop (its rework budget).
 */
export interface Task {
  id: string;
  projectId: string;
  teamId: string;
  title: string;
  /** Loop ids, oldest first. Empty while the task is only proposed. */
  runIds: string[];
  /** Set while Dana's proposal waits for your yes (the Weave item that decides it). */
  proposal?: { itemId: string; at: string; note: string; purpose: string };
  /** Nothing behind it can play yet (no recording): always labelled. */
  preview?: boolean;
  /** The recording a Fast-forward splices into (D5). */
  recordingKey?: string;
  /** The chat thread the task came from; Dana posts results there. */
  sessionId?: string;
}

/** What crossed the delegation boundary into a loop, and what stayed with Dana (PRODUCT §6). */
export interface Brief {
  tokens: number;
  objective: string;
  constraints: string[];
  /** Completion criteria. Dana starts from the team's and narrows them to the task. */
  criteria: string[];
  /** Picked per loop from each specialist's USER.md. */
  preferences: string[];
  stayed: string[];
}

// ---- Run events (append-only; the only thing the loop view reads) ----
export const RUN_EVENT_TYPES = [
  "run.started",
  "step.started",
  "step.finished",
  "agent.message",
  "tool.call",
  "tool.result",
  "tool.denied",
  "context.snapshot",
  "handoff",
  "review.verdict",
  "rework.requested",
  "criterion.checked",
  "budget.update",
  "artifact.created",
  "run.blocked",
  "run.stopped",
  "run.finished",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  runId: string;
  seq: number;
  /** seconds from run start (recorded timeline) */
  t: number;
  type: RunEventType;
  actorAgentId?: string;
  /** Typed per event type in events.ts (`RunEventPayloads`). */
  payload: Record<string, unknown>;
}

/**
 * work = doing a step · rework = redoing it after a bounce · bounce = the reviewer sent it back ·
 * wait = waiting on you · blocked = waiting on a teammate's step
 */
export type SegmentKind = "work" | "rework" | "bounce" | "wait" | "blocked";
export interface RunSegment {
  agentId: string;
  label: string;
  /** The team workflow step this belongs to. */
  stage: string;
  start: number;
  end: number;
  kind: SegmentKind;
}

/** running · blocked (stopped on a budget; needs you) · accepted · stopped (by you) */
export type RunStatus = "running" | "blocked" | "accepted" | "stopped";

/** real = a recorded real run; illustrative = hand-made mock data, always labelled (D9). */
export type RecordingKind = "real" | "illustrative";

/** One loop of a task. Times are seconds from `startedAt`. */
export interface Run {
  id: string;
  taskId: string;
  teamId: string;
  /** Loop number within the task, from 1. */
  n: number;
  objective: string;
  status: RunStatus;
  startedAt: string;
  /** A real run recorded earlier and played back. Always badged. */
  recorded: boolean;
  /** Finished loops: total length. Running loops: where "now" is. */
  durationS: number;
  /** Running loops only: expected length. */
  etaS?: number;
  /** Spend so far (at the end, or at "now"). */
  costUsd: number;
  budget: { costUsd: number; timeS: number };
  reworkBudget: number;
  /** Dana's own base context, for comparison with each specialist's. */
  assistantTokens: number;
  brief: Brief;
  /** Derived from step.started / step.finished events by the server (RUN-7). */
  segments: RunSegment[];
  /** How a finished loop ended, in a sentence. */
  outcome?: string;
  reportId?: string;
  /** Set on a recording, and on a live loop once it was spliced into one (D5). */
  recording?: { key: string; kind: RecordingKind; spliceT?: number };
}

export interface ContextSection {
  label: string;
  source: string;
  tokens: number;
  /** The text that was actually loaded (RUN-5). */
  content?: string;
  /** Token count is a tokenizer estimate, not provider usage. */
  estimated?: boolean;
}
export type ToolPolicy = "allowed" | "approval" | "blocked";
export interface ContextSnapshot {
  id: string;
  runId: string;
  agentId: string;
  step: string;
  assembledAtS: number;
  sections: ContextSection[];
  totalTokens: number;
  tools: { name: string; policy: ToolPolicy }[];
  lastDenied?: string;
  notLoaded: string;
  note: string;
  /** e.g. "sprite/fabric-coder-7f3 · egress: package index + model host only" */
  sandbox?: string;
}

export interface Report {
  id: string;
  runId: string;
  title: string;
  intro: string;
  summary: string;
  results: { config: string; ppl: number; delta: string; valid: boolean }[];
  caveats: string[];
  provenance: { label: string; value: string }[];
  /** Persona ids. */
  madeBy: string[];
  artifacts: { name: string; from: string; id?: string }[];
  emailed: boolean;
  /** Model, corpus, n, λ, split (REP-1). */
  setup?: { label: string; value: string }[];
  /** "illustrative" reports are labelled in the UI (REP-2). */
  kind?: RecordingKind;
}
