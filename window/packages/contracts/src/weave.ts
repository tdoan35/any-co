// Weave types (moved from apps/web/src/lib/mock/weave.ts). Phase 1 serves the seeded world;
// phase 2 generates these from real events.
import type { ToolPolicy } from "./domain";

export type PresenceState = "working" | "waiting" | "blocked" | "idle";
export interface Presence {
  agentId: string;
  state: PresenceState;
  /** "Step · what's happening", e.g. "Implement · needs a data fetch". */
  activity: string;
  since: string;
  /** Set when the agent is waiting on you: the inbox item that unblocks them. */
  itemId?: string;
}

export interface ItemAction {
  id: string;
  label: string;
  /** Option cards show this under the label (time, cost, consequence). */
  detail?: string;
  variant?: "primary" | "outline" | "ghost";
  /** Navigates instead of resolving the item. */
  href?: string;
  /** What resolving with this action changes on the page. */
  effect?: {
    /** Label on the item once it's done, e.g. "Allowed once". */
    outcome: string;
    /** Event line added to Pulse. */
    event?: string;
    /** Policy line added to Pulse when you grant autonomy. */
    policy?: string;
    /** The event line only shows under Everything. */
    quiet?: boolean;
    presence?: Omit<Presence, "since">[];
  };
}

export type ItemKind = "approval" | "question" | "escalation" | "proposal" | "finding" | "result";

interface ItemBase {
  id: string;
  /** Who is asking (persona id). */
  agentId: string;
  project: string;
  /** The Work task this is about. */
  taskId?: string;
  run?: { label: string; href: string };
  /** The one-line ask. */
  title: string;
  /** Short reference used in Dana's brief, e.g. "Jonah's data fetch". */
  brief: string;
  at: string;
  unread?: boolean;
  /** Work that waits on this, for the cost-of-delay line. */
  blocking?: { step: string; agentId: string; since: string };
  /** "Why you're seeing this." */
  why: string;
  /** Event-based snooze options, on top of the time-based ones. */
  snoozeEvents?: string[];
  /** Seeded as snoozed until this label. */
  snoozedUntil?: string;
  actions: ItemAction[];
}

export interface ApprovalItem extends ItemBase {
  kind: "approval";
  tool: string;
  policy: ToolPolicy;
  policyNote: string;
  /** Set for human-authority gates (external send, spend, merge, credentials): no "always" option. */
  gated?: string;
  preview: { label: string; value: string }[];
  excerpt?: string;
}
export interface QuestionItem extends ItemBase { kind: "question"; question: string; context: string[] }
export interface EscalationItem extends ItemBase {
  kind: "escalation";
  body: string;
  budget: { used: number; total: number };
  history: { agentId: string; text: string; at: string }[];
}
export interface ProposalItem extends ItemBase {
  kind: "proposal";
  purpose: string;
  roster: { agentId: string; status: "existing" | "lead" }[];
  crosses: string;
  stays: string;
}
export interface FindingItem extends ItemBase {
  kind: "finding";
  source: { title: string; venue: string; url: string };
  relevance: string;
  challenges?: { owner: string; text: string };
}
export interface ResultItem extends ItemBase { kind: "result"; reportId: string }

export type InboxItem = ApprovalItem | QuestionItem | EscalationItem | ProposalItem | FindingItem | ResultItem;

export type Health = "on_track" | "at_risk" | "done";
interface EntryBase {
  id: string;
  at: string;
  /** Routine noise: shown only under Everything. */
  quiet?: boolean;
}
export interface UpdateEntry extends EntryBase {
  kind: "update";
  authorId: string;
  project: string;
  title: string;
  health: Health;
  body: string;
  diff: { label: string; from: string; to: string }[];
  links: { label: string; href?: string; itemId?: string; artifact?: boolean }[];
  acked?: boolean;
  replies?: { text: string; at: string }[];
}
export interface EventEntry extends EntryBase {
  kind: "event";
  /** Persona id, or "you". */
  actorId: string;
  text: string;
  artifact?: string;
}
export interface MemoryEntry extends EntryBase {
  kind: "memory";
  agentId: string;
  text: string;
  source: string;
  decision?: "kept" | "forgotten";
  /** Set on pulse entries backed by the memories table: Keep/Forget write through to it. */
  memoryId?: string;
}
export interface PolicyEntry extends EntryBase { kind: "policy"; agentId: string; text: string }
export type PulseEntry = UpdateEntry | EventEntry | MemoryEntry | PolicyEntry;

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  kind: "meeting" | "focus" | "personal";
}

/** GET /api/weave */
export interface WeaveSnapshot {
  items: InboxItem[];
  pulse: PulseEntry[];
  presence: Presence[];
  calendar: CalendarEvent[];
}
