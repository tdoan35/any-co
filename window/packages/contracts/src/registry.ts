// Registry types: who exists (agents, teams, orgs) and where you talk to them (sessions).
// Moved from apps/web/src/lib/mock/{assistant,studio,teams,sessions,suggestions}.ts.
import type { Project } from "./domain";

export interface Suggestion {
  label: string;
  prompt: string;
  /** Recent session this suggestion was derived from (shown as the reason). */
  from?: string;
}

export interface SpriteAvatar {
  /** Portrait image. Shown alone when there is no strip, and as the fallback under one. */
  still: string;
  /** Optional idle loop: a single-row strip of `frames` square frames. */
  strip?: string;
  frames?: number;
  fps?: number;
  /** Optional loop played instead of the idle strip while the agent is working (same strip format). */
  working?: { strip: string; frames: number; fps: number };
}

export interface ChatAgent {
  /** Persona slug: the one agent id space (NAME-1). */
  id: string;
  name: string;
  role: string;
  /** Animated portrait. Agents without art fall back to an initial circle. */
  avatar?: SpriteAvatar;
  /** Tailwind classes for the initial-circle fallback. */
  tone: string;
  summary: string;
  personality: string;
  traits: string[];
  model: string;
  contextTokens: number;
  memory: { label: string; value: string }[];
  tools: { name: string; note: string; policy: "allowed" | "approval" | "blocked" }[];
  greeting: string;
  placeholder: string;
  /** Custom suggestion chips. Omit to use the shared smart-suggestion pool. */
  suggestions?: Suggestion[];
}

/** The three markdown files every agent workspace loads, in load order. */
export type WorkspaceFileName = "SOUL.md" | "IDENTITY.md" | "USER.md";

export interface AgentWorkspace {
  files: { name: WorkspaceFileName; body: string }[];
  skills: { name: string; description: string }[];
  connectors: { name: string; note: string; status: "connected" | "available" }[];
  /** Long-term memories. Empty for a freshly added profile. `id` set on rows backed by the
   * memories table (the Mnemosyne import): that's what Keep/Forget address. */
  memories: { text: string; source: string; when: string; id?: string }[];
}

export interface StudioProfile {
  agent: ChatAgent;
  /** One line for the compact card. */
  tagline: string;
  workspace: AgentWorkspace;
  /** Where a profile came from, when that's worth showing (e.g. created in chat). */
  origin?: string;
  /** Community profiles only. */
  author?: string;
  installs?: number;
  /** The registry only serves active agents; proposed ones stay hidden until approved (SEED-1). */
  status?: "active";
  /** AgentMail address, once created (CARD-3). */
  inbox?: string;
}

export interface TeamMember {
  agentId: string;
  /** What this agent does on this team (agents can hold different jobs on different teams). */
  duty: string;
  lead?: boolean;
}

/** One workflow step. Several agents on one step run in parallel. */
export interface WorkflowStage {
  label: string;
  agentIds: string[];
  note: string;
  /** The review step that can send work back to the lead. */
  gate?: boolean;
}

export interface StudioTeam {
  id: string;
  name: string;
  tagline: string;
  purpose: string;
  status: "active" | "idle";
  origin: string;
  /** Community teams only. */
  author?: string;
  installs?: number;
  members: TeamMember[];
  workflow: WorkflowStage[];
  reworkBudget: number;
  criteria: string[];
}

/** A handoff edge between two teams' leads. */
export interface OrgHandoff {
  from: string;
  to: string;
  question: string;
  /** Not built yet: always shown with a Preview label. */
  preview?: boolean;
}

export interface Organization {
  id: string;
  name: string;
  /** Dana sits at the top of every org; teams hang off her by their leads. */
  headId: string;
  /** Team instances. The same team can appear more than once (each is its own copy in this org). */
  slots: { key: string; teamId: string }[];
  handoffs: OrgHandoff[];
}

/** unread = new reply you haven't seen, input = waiting on you, idle = nothing pending */
export type SessionStatus = "unread" | "input" | "idle";
export interface Session {
  id: string; title: string; href: string; projectId?: string; status?: SessionStatus;
  /** Who the thread is with. A team thread is addressed to the team's lead. */
  agentId: string; teamId?: string;
  messages: number;
  /** Unseen replies, for `unread` threads. */
  newReplies?: number;
  /** Relative time of the last message. */
  updated: string;
}

/** A persona Dana can give a new specialist on its proposal card (D1). */
export interface PersonaPoolEntry {
  id: string;
  name: string;
  /** The role this portrait is meant for, e.g. "Research Lead". */
  role: string;
  avatar: SpriteAvatar;
}

/** GET /api/registry: everything that exists right now. Active rows only. */
export interface Registry {
  agents: StudioProfile[];
  communityAgents: StudioProfile[];
  teams: StudioTeam[];
  communityTeams: StudioTeam[];
  organizations: Organization[];
  projects: Project[];
  sessions: Session[];
  personaPool: PersonaPoolEntry[];
}
