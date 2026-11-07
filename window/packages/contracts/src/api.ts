// HTTP API shapes. Read-model schemas are checked against the domain
// interfaces with `satisfies`, so the two can't drift. DATA validates its responses with them in tests.
import { z } from "zod";
import type { Brief, ContextSnapshot, Project, Report, Run, RunEvent, RunSegment, Task } from "./domain";
import { RUN_EVENT_TYPES } from "./domain";
import { SegmentKindSchema } from "./events";

const RecordingKindSchema = z.enum(["real", "illustrative"]);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  archived: z.boolean().optional(),
}) satisfies z.ZodType<Project>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  title: z.string(),
  runIds: z.array(z.string()),
  proposal: z.object({ itemId: z.string(), at: z.string(), note: z.string(), purpose: z.string() }).optional(),
  preview: z.boolean().optional(),
  recordingKey: z.string().optional(),
  sessionId: z.string().optional(),
}) satisfies z.ZodType<Task>;

export const BriefSchema = z.object({
  tokens: z.number(),
  objective: z.string(),
  constraints: z.array(z.string()),
  criteria: z.array(z.string()),
  preferences: z.array(z.string()),
  stayed: z.array(z.string()),
}) satisfies z.ZodType<Brief>;

export const RunSegmentSchema = z.object({
  agentId: z.string(),
  label: z.string(),
  stage: z.string(),
  start: z.number(),
  end: z.number(),
  kind: SegmentKindSchema,
}) satisfies z.ZodType<RunSegment>;

export const RunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  teamId: z.string(),
  n: z.number().int(),
  objective: z.string(),
  status: z.enum(["running", "blocked", "accepted", "stopped"]),
  startedAt: z.string(),
  recorded: z.boolean(),
  durationS: z.number(),
  etaS: z.number().optional(),
  costUsd: z.number(),
  budget: z.object({ costUsd: z.number(), timeS: z.number() }),
  reworkBudget: z.number().int(),
  assistantTokens: z.number(),
  brief: BriefSchema,
  segments: z.array(RunSegmentSchema),
  outcome: z.string().optional(),
  reportId: z.string().optional(),
  recording: z.object({ key: z.string(), kind: RecordingKindSchema, spliceT: z.number().optional() }).optional(),
}) satisfies z.ZodType<Run>;

export const RunEventSchema = z.object({
  runId: z.string(),
  seq: z.number().int(),
  t: z.number(),
  type: z.enum(RUN_EVENT_TYPES),
  actorAgentId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<RunEvent>;

export const ContextSnapshotSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string(),
  step: z.string(),
  assembledAtS: z.number(),
  sections: z.array(z.object({
    label: z.string(),
    source: z.string(),
    tokens: z.number(),
    content: z.string().optional(),
    estimated: z.boolean().optional(),
  })),
  totalTokens: z.number(),
  tools: z.array(z.object({ name: z.string(), policy: z.enum(["allowed", "approval", "blocked"]) })),
  lastDenied: z.string().optional(),
  notLoaded: z.string(),
  note: z.string(),
  sandbox: z.string().optional(),
}) satisfies z.ZodType<ContextSnapshot>;

export const ReportSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  intro: z.string(),
  summary: z.string(),
  results: z.array(z.object({ config: z.string(), ppl: z.number(), delta: z.string(), valid: z.boolean() })),
  caveats: z.array(z.string()),
  provenance: z.array(z.object({ label: z.string(), value: z.string() })),
  madeBy: z.array(z.string()),
  artifacts: z.array(z.object({ name: z.string(), from: z.string(), id: z.string().optional() })),
  emailed: z.boolean(),
  setup: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  kind: RecordingKindSchema.optional(),
}) satisfies z.ZodType<Report>;

// ---- Runs: splice and finalize (D5) ----

export const SpliceRequestSchema = z.object({ t: z.number().min(0) });
export type SpliceRequest = z.infer<typeof SpliceRequestSchema>;
/** POST /api/runs/:id/splice: the live run, now carrying the recording, and its merged log. */
export interface SpliceResponse { run: Run; events: RunEvent[] }
/** POST /api/runs/:id/finalize-splice (idempotent). */
export interface FinalizeResponse { reportId: string }

// ---- Chat (§4.3) ----

export type ChatTextPart = { type: "text"; text: string };
export type ChatToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  /** Set for server-executed tools; absent for human tools (propose_*) until you decide. */
  result?: unknown;
};
export type ChatPart = ChatTextPart | ChatToolCallPart;

/** One NDJSON line of POST /api/chat: a cumulative snapshot of the assistant message. */
export interface ChatStreamLine { content: ChatPart[] }

// Added for UI-CHAT (additive): the web's dev-mode checks on the chat stream and thread history.
export const ChatPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    argsText: z.string().optional(),
    result: z.unknown().optional(),
  }),
]) satisfies z.ZodType<ChatPart>;
export const ChatStreamLineSchema = z.object({ content: z.array(ChatPartSchema) }) satisfies z.ZodType<ChatStreamLine>;

export const ChatRequestSchema = z.object({
  sessionId: z.string(),
  /** The thread as the web runtime holds it, including human tool results ({decision}). */
  messages: z.array(z.unknown()),
  /** The composer's model picker, as a display name ("Opus 5.5"). Absent: Dana's registry model. */
  model: z.string().optional(),
  /** The composer's reasoning effort. Absent: off (Dana's latency default). */
  effort: z.enum(["off", "low", "medium", "high", "xhigh"]).optional(),
  /** Incognito threads skip personal-memory recall entirely (PRODUCT §10.7). Additive. */
  incognito: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: ChatPart[];
  createdAt: string;
}
/** GET /api/sessions/:id/messages */
export interface SessionMessages { sessionId: string; messages: ThreadMessage[] }
export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.array(ChatPartSchema),
  createdAt: z.string(),
}) satisfies z.ZodType<ThreadMessage>;
export const SessionMessagesSchema = z.object({ sessionId: z.string(), messages: z.array(ThreadMessageSchema) }) satisfies z.ZodType<SessionMessages>;

/** Body of every non-2xx response. */
export interface ApiError { error: string; owner?: string }
