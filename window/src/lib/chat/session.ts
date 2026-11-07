// Thread identity (IA-5): every thread has a sessionId, kept in the URL (`/?session=<id>`) so a
// reload or a title-bar tab restores it. The thread's history lives on the server: session-era
// threads load the event log (S3's projection), legacy ones today's messages endpoint, read-only.
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatPart, Session, SessionThreadMessage, SessionPart, ThreadMessage } from "@fabric/contracts";
import { httpApi, httpMode } from "@/lib/api";
import { attachStream, knownSessionId } from "@/lib/chat/session-stream";

export const SESSION_PARAM = "session";

/** Ids minted in this page that no turn has been sent on yet: no history, so they mount without a fetch. */
const minted = new Set<string>();

export function newSessionId(): string {
  const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  minted.add(id);
  return id;
}

export const threadPath = (sessionId: string) => `/?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`;

/** Where a sidebar row opens: its own thread, unless the row links somewhere specific (a board). */
export const sessionHref = (session: Session) => (session.href === "/" ? threadPath(session.id) : session.href);

/** A stored part as the runtime holds it. */
export function toRuntimePart(p: ChatPart) {
  if (p.type === "text") return { type: "text" as const, text: p.text };
  return {
    type: "tool-call" as const,
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    args: (p.args ?? {}) as Record<string, never>,
    argsText: p.argsText ?? JSON.stringify(p.args ?? {}),
    ...(p.result !== undefined ? { result: p.result } : {}),
  };
}

export const toRuntimeMessage = (m: ThreadMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: m.content.map(toRuntimePart),
  createdAt: new Date(m.createdAt),
});

export async function fetchHistory(sessionId: string): Promise<ThreadMessage[]> {
  return (await httpApi.getSessionMessages(sessionId)).messages;
}

/** True when the thread can't have history: minted here and never sent (session
 * threads and mock alike — the adapter marks a thread sent on its first turn). */
export const knownEmpty = (sessionId: string) => minted.has(sessionId);

/** A turn went out on this thread: from now on its history lives on the server. */
export const markSent = (sessionId: string) => { minted.delete(sessionId); };

/**
 * Runtime content from the session projection's parts: text and tool calls as
 * the runtime holds them; `ask-human` has no runtime part (the wait UI is
 * session-side), so it is dropped here.
 */
export const toRuntimeParts = (parts: readonly SessionPart[]) =>
  parts.flatMap((part) => (part.type === "ask-human" ? [] : [toRuntimePart(part)]));

const toRuntimeMessageLike = (message: SessionThreadMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role,
  content: toRuntimeParts(message.content),
  createdAt: new Date(message.createdAt),
});

/**
 * The thread's stored messages: the session stream's projection when the thread
 * lives on the log (the attach also starts the follow, so a turn in flight
 * surfaces through it), the legacy read model when it predates sessions. None
 * for a known-empty thread.
 */
export async function loadThread(sessionId: string): Promise<ThreadMessageLike[]> {
  if (knownEmpty(sessionId)) return [];
  try {
    const stream = attachStream(knownSessionId(sessionId) ?? sessionId);
    await stream.ready;
    return stream.state.messages.map(toRuntimeMessageLike);
  } catch (err) {
    // No stream for this id: a legacy thread (chat_messages, no log) renders
    // read-only from today's endpoint. No migration (default 2026-10-12).
    console.warn("[chat] no session stream; falling back to the legacy history", err);
    if (!httpMode) return [];
    return (await fetchHistory(sessionId)).map(toRuntimeMessage);
  }
}
