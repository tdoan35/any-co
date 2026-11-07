// Durable-session protocol — ARCHITECTURE §10 (HTTP commands plus SSE streams
// resumed from Last-Event-ID) and RUNTIME §8. Shared by the server, web and
// mobile apps.
//
// Dependency-light on purpose: zod only. The projection (`projectThread`,
// `applyDelta`) reads plain event JSON with loose payload guards — the payload
// shapes themselves are `@fabric/core`'s business (RUNTIME §3) — so this
// package never depends on the runtime.
import { z } from "zod";
import type { ChatToolCallPart, ThreadMessage } from "./api";

// ---- Commands -------------------------------------------------------------

export const CreateSessionRequestSchema = z.object({
  agentId: z.string(),
  incognito: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({ sessionId: z.string() });
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/** `clientMessageId` becomes `message.received.platformMessageId`, which makes the post idempotent. */
export const PostMessageRequestSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().min(1).max(32_000),
  attachments: z.array(z.unknown()).optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const PostMessageResponseSchema = z.object({ seq: z.number().int() });
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

// -- T17 (ANY-82): the wait answer and the approval mode (RUNTIME §7, §13) ----

/** The body of `POST /sessions/:id/waits/:waitId`: R10's decision. Any
 * non-empty text; `approve:` waits narrow it to approve/deny at the route. */
export const RespondWaitRequestSchema = z.object({ decision: z.string().min(1) });
export type RespondWaitRequest = z.infer<typeof RespondWaitRequestSchema>;

/** R10's `respond` outcome, verbatim: accepted, or refused with its reason. */
export const RespondWaitResponseSchema = z.union([
  z.object({ outcome: z.literal("accepted") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["expired", "already_answered", "cancelled", "gated"]),
  }),
]);
export type RespondWaitResponse = z.infer<typeof RespondWaitResponseSchema>;

/** The body of `PUT /sessions/:id/approval-mode`: T3's session modes. */
const ApprovalMode = z.enum(["ask", "auto_edits", "full_auto"]);

export const SetApprovalModeRequestSchema = z.object({ mode: ApprovalMode });
export type SetApprovalModeRequest = z.infer<typeof SetApprovalModeRequestSchema>;

export const SetApprovalModeResponseSchema = z.object({ mode: ApprovalMode });
export type SetApprovalModeResponse = z.infer<typeof SetApprovalModeResponseSchema>;

/** One row of the thread list. */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  incognito: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ---- Stream frames ----------------------------------------------------------

export type SessionEventClass = "fact" | "telemetry";

/** One log event as it crosses the stream: the payload stays unparsed. */
export const SessionEventSchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  class: z.enum(["fact", "telemetry"]),
  payload: z.unknown(),
  ts: z.string(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** Cumulative text of one model call: a client joining mid-call needs nothing earlier. */
export interface SessionDelta {
  turn: number;
  callNo: number;
  text: string;
}

export type SessionFrame =
  | { event: "event"; id: number; data: SessionEvent }
  | { event: "delta"; data: SessionDelta }
  | { event: "ping" };

const DeltaSchema = z.object({ turn: z.number().int(), callNo: z.number().int(), text: z.string() });

export class SessionFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFrameError";
  }
}

/** The SSE wire text of one frame (an `event:` block followed by a blank line). */
export function encodeFrame(frame: SessionFrame): string {
  switch (frame.event) {
    case "event":
      return `event: event\nid: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`;
    case "delta":
      return `event: delta\ndata: ${JSON.stringify(frame.data)}\n\n`;
    case "ping":
      return "event: ping\n\n";
  }
}

function parseFrameData<T>(schema: z.ZodType<T>, raw: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SessionFrameError(`${what}: data is not JSON (${(e as Error).message})`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SessionFrameError(`${what}: ${parsed.error.message}`);
  return parsed.data;
}

/** One parsed frame; throws `SessionFrameError` on a malformed block. */
export function parseFrame(text: string): SessionFrame {
  let event: string | undefined;
  let id: number | undefined;
  let data: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    if (sep < 0) throw new SessionFrameError(`malformed SSE line: ${JSON.stringify(line)}`);
    const field = line.slice(0, sep);
    const value = line.slice(sep + (line[sep + 1] === " " ? 2 : 1));
    if (field === "event") event = value;
    else if (field === "id") id = Number(value);
    else if (field === "data") data = data === undefined ? value : `${data}\n${value}`;
    // `retry` and unknown fields carry no frame data; ignored.
  }
  switch (event) {
    case "event": {
      if (id === undefined || !Number.isInteger(id)) throw new SessionFrameError("event frame without an integer id");
      if (data === undefined) throw new SessionFrameError("event frame without data");
      return { event: "event", id, data: parseFrameData(SessionEventSchema, data, "event frame") };
    }
    case "delta": {
      if (data === undefined) throw new SessionFrameError("delta frame without data");
      return { event: "delta", data: parseFrameData(DeltaSchema, data, "delta frame") };
    }
    case "ping":
      return { event: "ping" };
    default:
      throw new SessionFrameError(`unknown event kind: ${String(event)}`);
  }
}

// ---- Thread projection ------------------------------------------------------

export type ToolPartStatus = "running" | "done" | "interrupted" | "denied";

/** A tool call on the thread, with the lifecycle the resolution events drive. */
export interface SessionToolCallPart extends ChatToolCallPart {
  status: ToolPartStatus;
}

export interface AskHumanPart {
  type: "ask-human";
  waitId: string;
  kind: "confirm" | "approve" | "answer";
  prompt: string;
  /** Present once `human.responded` answers the wait. */
  response?: { decision: string; by: string };
}

export type SessionPart =
  | { type: "text"; text: string }
  | SessionToolCallPart
  | AskHumanPart;

export interface RecordedDisposition {
  kind: "direct" | "agent" | "team" | "propose" | "clarify";
  /** The routed-to agent/team/clarifier; null for a direct answer. */
  target: string | null;
  reason: string;
}

export interface ThreadMessageMetadata {
  disposition?: RecordedDisposition;
}

/** A thread message as the session projection builds it: `ThreadMessage` plus
 * session-only extras. `provisional` marks the assistant message `applyDelta`
 maintains for a call still in flight; `projectThread` never emits one. */
export type SessionThreadMessage = Omit<ThreadMessage, "content"> & {
  content: SessionPart[];
  provisional?: { turn: number; callNo: number };
  metadata?: ThreadMessageMetadata;
};

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const ASK_KINDS = ["confirm", "approve", "answer"] as const;
const DISPOSITION_KINDS = ["direct", "agent", "team", "propose", "clarify"] as const;

function asDisposition(v: unknown): RecordedDisposition | undefined {
  const rec = asRecord(v);
  const kind = asString(rec["kind"]);
  if (!kind || !(DISPOSITION_KINDS as readonly string[]).includes(kind)) return undefined;
  if (!("target" in rec) || !(rec["target"] === null || typeof rec["target"] === "string")) return undefined;
  const reason = asString(rec["reason"]);
  if (reason === undefined) return undefined;
  return { kind: kind as RecordedDisposition["kind"], target: rec["target"] as string | null, reason };
}

function findToolPart(messages: SessionThreadMessage[], callId: string, pred?: (p: SessionToolCallPart) => boolean): SessionToolCallPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]!.content) {
      if (part.type === "tool-call" && part.toolCallId === callId && (!pred || pred(part))) return part;
    }
  }
  return undefined;
}

function findAskPart(messages: SessionThreadMessage[], waitId: string): AskHumanPart | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "ask-human" && part.waitId === waitId) return part;
    }
  }
  return undefined;
}

/**
 * The thread as of these events. Pure: sorts by `seq`, drops duplicates, and
 * ignores unknown event types so older clients survive newer logs. Tool parts
 * attach to the turn's assistant message; a `human.requested` stands alone
 * until `human.responded` answers it.
 */
export function projectThread(events: SessionEvent[]): SessionThreadMessage[] {
  const bySeq = new Map<number, SessionEvent>();
  for (const event of events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  const ordered = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);

  const messages: SessionThreadMessage[] = [];
  let pendingParts: SessionToolCallPart[] = [];
  let disposition: RecordedDisposition | undefined;

  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const ts = event.ts;
    switch (event.type) {
      case "message.received": {
        const text = asString(payload["text"]);
        if (text === undefined) break;
        const id = asString(payload["platformMessageId"]) ?? `msg:${event.seq}`;
        messages.push({ id, role: "user", content: [{ type: "text", text }], createdAt: ts });
        break;
      }
      case "agent.message": {
        const text = asString(payload["text"]);
        if (text === undefined) break;
        const content: SessionPart[] = [{ type: "text", text }, ...pendingParts];
        pendingParts = [];
        const metadata: ThreadMessageMetadata | undefined = disposition ? { disposition } : undefined;
        messages.push({ id: `msg:${event.seq}`, role: "assistant", content, createdAt: ts, metadata });
        break;
      }
      case "tool.call": {
        const tool = asString(payload["tool"]);
        if (tool === undefined) break;
        pendingParts.push({
          type: "tool-call",
          toolCallId: asString(payload["callId"]) ?? `call:${event.seq}`,
          toolName: tool,
          args: "args" in payload ? payload["args"] : null,
          argsText: asString(payload["argsText"]),
          status: "running",
        });
        break;
      }
      case "tool.completed": {
        const callId = asString(payload["callId"]);
        const part = callId && findToolPart(messages, callId, (p) => p.status === "running");
        const pending = callId && pendingParts.find((p) => p.toolCallId === callId);
        const target = part ?? pending;
        if (target) {
          target.status = "done";
          if ("result" in payload) target.result = payload["result"];
        }
        break;
      }
      case "tool.interrupted": {
        const callId = asString(payload["callId"]);
        const target = (callId && findToolPart(messages, callId, (p) => p.status === "running")) ?? (callId && pendingParts.find((p) => p.toolCallId === callId));
        if (target) target.status = "interrupted";
        break;
      }
      case "tool.denied": {
        // `callId` is optional on the event; without it there is nothing to match.
        const callId = asString(payload["callId"]);
        const target = (callId && findToolPart(messages, callId, (p) => p.status === "running")) ?? (callId && pendingParts.find((p) => p.toolCallId === callId));
        if (target) target.status = "denied";
        break;
      }
      case "human.requested": {
        const waitId = asString(payload["waitId"]);
        const prompt = asString(payload["prompt"]);
        if (!waitId || prompt === undefined) break;
        const kind = asString(payload["kind"]);
        const ask: AskHumanPart = {
          type: "ask-human",
          waitId,
          kind: kind && (ASK_KINDS as readonly string[]).includes(kind) ? (kind as AskHumanPart["kind"]) : "answer",
          prompt,
        };
        messages.push({ id: `ask:${waitId}`, role: "assistant", content: [ask], createdAt: ts });
        break;
      }
      case "human.responded": {
        const waitId = asString(payload["waitId"]);
        const decision = asString(payload["decision"]);
        const by = asString(payload["by"]);
        const part = waitId && findAskPart(messages, waitId);
        if (part && decision !== undefined && by !== undefined) part.response = { decision, by };
        break;
      }
      case "disposition.recorded": {
        const recorded = asDisposition(payload);
        if (!recorded) break;
        disposition = recorded;
        // A disposition recorded after the reply still lands on it.
        for (const message of messages) {
          if (message.role === "assistant" && !message.metadata?.disposition) {
            message.metadata = { ...message.metadata, disposition: recorded };
          }
        }
        break;
      }
      default:
        break; // Unknown types are ignored: forward compatible.
    }
  }

  return messages;
}

/**
 * Fold one delta into the thread: the single provisional assistant message for
 * `(turn, callNo)` is replaced in place with the latest cumulative text, or
 * appended when the call has no provisional yet.
 */
export function applyDelta(messages: readonly (ThreadMessage | SessionThreadMessage)[], delta: SessionDelta): SessionThreadMessage[] {
  let replaced = false;
  const next = messages.map((message): SessionThreadMessage => {
    const m = message as SessionThreadMessage;
    const p = m.provisional;
    if (replaced || p === undefined || p.turn !== delta.turn || p.callNo !== delta.callNo) return m;
    replaced = true;
    return { ...m, content: [{ type: "text", text: delta.text }] };
  });

  if (!replaced) {
    next.push({
      id: `delta:${delta.turn}:${delta.callNo}`,
      role: "assistant",
      content: [{ type: "text", text: delta.text }],
      createdAt: new Date().toISOString(),
      provisional: { turn: delta.turn, callNo: delta.callNo },
    });
  }
  return next;
}
