// ANY-62 S12b — the client side of RUNTIME §13 "post, then follow the stream".
// One stream per server session, attached on first touch: the backlog arrives
// over REST (`GET /api/sessions/:id/events`, projected with S3's
// `projectThread`), the tail over the S12a follow loop. Turns ride the same
// stream: `sessionTurn` posts the message, then relays the provisional text
// from `applyDelta` until the turn's `agent.message` lands, surviving
// reconnects, sleep and server restarts (the follow never gives up; S6
// re-sends the current delta on reconnect).
//
// The transport is `api` — the same calls in http mode (the @fabric/contracts
// client over fetch) and mock mode (the in-memory store) — so nothing here
// branches on the mode. Thread identity stays client-side (the `?session=`
// key); `ensureSessionId` maps it to the server id once, and the map survives
// reloads through sessionStorage.
import { applyDelta, projectThread } from "@fabric/contracts";
import type { SessionDelta, SessionEvent, SessionThreadMessage } from "@fabric/contracts";
import { api } from "@/lib/api";

/** The agent the visible thread is addressing; kept current by the chat screen
 * (the same seam as `mockContext.agent`: set on every render, read at run time). */
export const chatAgentContext = { id: "dana" };

// ---- Thread key → server session id -----------------------------------------

const aliasStorageKey = "fabric.session-aliases";
const aliases = new Map<string, string>();
try {
  for (const [key, value] of Object.entries(JSON.parse(sessionStorage.getItem(aliasStorageKey) ?? "{}") as Record<string, string>)) {
    aliases.set(key, value);
  }
} catch {
  // Private mode or disabled storage: the alias map just lives for the page.
}
const persistAliases = (): void => {
  try {
    sessionStorage.setItem(aliasStorageKey, JSON.stringify(Object.fromEntries(aliases)));
  } catch {
    // see above
  }
};

interface StreamHandle {
  /** Resolves once the REST backlog is projected; rejects when the session has none. */
  ready: Promise<void>;
  readonly state: { events: SessionEvent[]; messages: SessionThreadMessage[] };
  /** Bumps on every change; `changeAfter` resolves on the next one. */
  readonly version: number;
  changeAfter(seen: number): Promise<void>;
  on(listener: () => void): () => void;
}

const streams = new Map<string, StreamHandle>();

/** The live stream backing a server session, when one is attached. */
export const peekStream = (serverId: string): StreamHandle | undefined => streams.get(serverId);

/** Test seam (the storybook harness's per-story reset): drop every stream, alias and
 * pending ensure, so a story never inherits an earlier story's session state. */
export function resetSessionStreams(): void {
  streams.clear();
  aliases.clear();
  ensuring.clear();
  persistAliases();
}

/** The server session behind a thread key, when one is known. */
export const knownSessionId = (threadKey: string): string | undefined =>
  aliases.get(threadKey) ?? (streams.has(threadKey) ? threadKey : undefined);

const ensuring = new Map<string, Promise<string>>();

/** The thread's server session: the mapped one, one a stream already backs, or a
 * freshly created (POST /api/sessions, with the chosen agent and incognito). */
export async function ensureSessionId(threadKey: string, args: { agentId: string; incognito?: boolean }): Promise<string> {
  const known = knownSessionId(threadKey);
  if (known) return known;
  const inflight = ensuring.get(threadKey);
  if (inflight) return inflight;
  const created = (async () => {
    const { sessionId } = await api.createSession({ agentId: args.agentId, incognito: args.incognito });
    aliases.set(threadKey, sessionId);
    persistAliases();
    return sessionId;
  })().finally(() => ensuring.delete(threadKey));
  ensuring.set(threadKey, created);
  return created;
}

/** The live stream for a server session, attached on first touch (backlog over
 * REST, tail over the follow); shared by the loader, the adapter and the resync hook. */
export function attachStream(serverId: string): StreamHandle {
  const existing = streams.get(serverId);
  if (existing) return existing;

  const state: StreamHandle["state"] = { events: [], messages: [] };
  const listeners = new Set<() => void>();
  let version = 0;
  let pendingDelta: SessionDelta | undefined;

  const notify = (): void => {
    version += 1;
    for (const listener of Array.from(listeners)) listener();
  };

  const handle: StreamHandle = {
    ready: undefined as unknown as Promise<void>,
    state,
    get version() {
      return version;
    },
    // Wake on the next change, whatever it is; the caller re-reads the state.
    // The pre-check (version > seen) covers a change that landed while the
    // caller was between reading the state and waiting.
    changeAfter(seen: number) {
      if (version > seen) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wakeup = () => {
          listeners.delete(wakeup);
          resolve();
        };
        listeners.add(wakeup);
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const reproject = (): void => {
    state.messages = projectThread(state.events);
    // A turn still streaming keeps its provisional text across logged events;
    // its own agent.message clears the delta before this runs.
    if (pendingDelta) state.messages = applyDelta(state.messages, pendingDelta);
  };

  handle.ready = (async () => {
    const events = await api.getSessionEvents(serverId);
    state.events = events;
    state.messages = projectThread(events);
    notify();
    void api.followSession(serverId, {
      after: events.at(-1)?.seq ?? 0,
      onEvent: (event) => {
        // The follow deduplicates against its own cursor; this guard keeps a
        // racing REST backlog from double-projecting the same event.
        if (event.seq <= (state.events.at(-1)?.seq ?? 0)) return;
        state.events.push(event);
        if (event.type === "agent.message") pendingDelta = undefined;
        reproject();
        notify();
      },
      onDelta: (delta) => {
        pendingDelta = delta;
        state.messages = applyDelta(state.messages, delta);
        notify();
      },
    });
  })().catch((err: unknown) => {
    streams.delete(serverId); // a dead attach (unknown id) must not stick
    throw err;
  });

  streams.set(serverId, handle);
  return handle;
}

/** Stream updates for a thread key, once a stream backs it. */
export function onStreamChange(threadKey: string, listener: () => void): () => void {
  const serverId = knownSessionId(threadKey);
  const stream = serverId ? streams.get(serverId) : undefined;
  return stream ? stream.on(listener) : () => {};
}

// ---- Turns -------------------------------------------------------------------

export interface SessionTurnArgs {
  text: string;
  /** The human-tool stamp on a continuation run; the mock brain folds it in. */
  attachments?: unknown[];
  agentId: string;
  incognito?: boolean;
  signal?: AbortSignal;
}

const abortable = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/**
 * One chat turn, RUNTIME §13: create the session if the thread has none, post
 * the message, then relay the stream — the provisional text as it grows, then
 * the projected assistant message the turn's `agent.message` means, and return.
 * The wait rides the stream's reconnect loop, so a dropped connection or a
 * restart stalls the turn instead of killing it. The optional `done` (the mock
 * turn runner) surfaces a failed turn as a thrown error.
 */
export async function* sessionTurn(threadKey: string, args: SessionTurnArgs): AsyncGenerator<{ content: SessionThreadMessage["content"] }> {
  const serverId = await ensureSessionId(threadKey, args);
  const stream = attachStream(serverId);
  await stream.ready;

  const post = await api.postMessage(serverId, { text: args.text, attachments: args.attachments });
  const { done } = post;
  // The turn runner's rejection must stay handled even when it lands between
  // the post and the first wait (the mock brain fails synchronously).
  done?.catch(() => {});
  // The per-turn completion (the mock's `done`) is the authoritative end: the
  // agent.message of a concurrent turn would end this one early, so on the raw
  // event stream (http, no `done`) the first agent.message after our
  // message.received stands in. Either way the provisional keeps streaming
  // until the turn is done — the final is yielded once, at the end.
  let doneSettled = false;
  const doneWait = done?.then(
    () => { doneSettled = true; },
    (err: unknown) => { doneSettled = true; throw err; },
  );
  let lastText: string | undefined;

  for (;;) {
    if (args.signal?.aborted) return;
    const { events, messages } = stream.state;

    if (done === undefined && events.some((event) => event.seq > post.seq && event.type === "agent.message")) {
      const final = [...messages].reverse().find((message) => message.role === "assistant" && !message.provisional);
      if (final) yield { content: final.content };
      return;
    }

    // The turn's provisional text, as far as it has grown.
    const provisional = messages.filter((message) => message.provisional).at(-1);
    const text = provisional?.content[0]?.type === "text" ? provisional.content[0].text : undefined;
    if (text !== undefined && text !== lastText) {
      lastText = text;
      yield { content: [{ type: "text" as const, text }] };
    }

    const race: Promise<void>[] = [stream.changeAfter(stream.version), abortable(args.signal)];
    if (doneWait) race.push(doneWait);
    await Promise.race(race);
    if (doneSettled) {
      // The turn's reply is finalized; a rejection has already thrown above.
      if (args.signal?.aborted) return;
      const final = [...stream.state.messages].reverse().find((message) => message.role === "assistant" && !message.provisional);
      if (final) yield { content: final.content };
      return;
    }
  }
}
