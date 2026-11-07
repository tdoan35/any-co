// ANY-65 S12a — @fabric/contracts shared session client: post, follow, resume
// (RUNTIME §13 "post, then follow the stream"). One test per listed case, named by its ID.
import { expect, it, vi } from "vitest";
import { encodeFrame, type SessionEvent } from "../sessions";
import { createSession, followSession, postMessage } from "../session-client";

/** A well-formed session event; `payload` stays loose, as on the wire. */
const ev = (seq: number, type: string, payload: unknown = {}, ts = `2026-10-12T12:00:${String(seq).padStart(2, "0")}Z`): SessionEvent => ({
  seq,
  type,
  class: "fact",
  payload,
  ts,
});

const eventFrame = (seq: number, type: string, payload: unknown = {}) => encodeFrame({ event: "event", id: seq, data: ev(seq, type, payload) });
const deltaFrame = (turn: number, callNo: number, text: string) => encodeFrame({ event: "delta", data: { turn, callNo, text } });

/** An SSE response whose body is the given chunks, then closes. */
const sseResponse = (...chunks: string[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
};

/** An SSE response whose body stays open (never closes, sends nothing). */
const hangingResponse = (): Response => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });

const jsonResponse = (value: unknown, status = 200): Response => Response.json(value, { status });

/** A fetch mock playing a script: each entry is a response, a response factory, or an error to throw. */
const fakeFetch = (script: Array<Response | (() => Response) | Error>) => {
  const queue = [...script];
  return vi.fn(async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
    const step = queue.shift();
    if (step === undefined) throw new Error("fakeFetch: unexpected extra call");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? (step as () => Response)() : step;
  });
};

/**
 * Flushes microtasks until `when` holds. Never moves the fake clock — the
 * tests below assert exact backoff boundaries and must know where the clock
 * stands. The SSE delivery path (stream reads, frame parse) is pure
 * microtasks, so this is enough to receive scripted chunks.
 */
const until = async (when: () => boolean, budget = 1000): Promise<void> => {
  for (let i = 0; i < budget && !when(); i++) await Promise.resolve();
  expect(when()).toBe(true);
};

it("K1 followSession delivers events in seq order and calls onDelta with cumulative text", async () => {
  vi.useFakeTimers();
  const streamFrames = [
    eventFrame(1, "message.received", { text: "hi", attachments: [], surface: "app", sender: "dana", platformMessageId: "pm-1" }),
    deltaFrame(1, 1, "Hel"),
    deltaFrame(1, 1, "Hello"),
    eventFrame(2, "agent.message", { text: "Hello" }),
  ].join("");
  const fetchMock = fakeFetch([sseResponse(streamFrames), hangingResponse()]);

  const events: SessionEvent[] = [];
  const deltas: Array<{ turn: number; callNo: number; text: string }> = [];
  const ctrl = new AbortController();
    const done = followSession(fetchMock, "http://fabric.test", "sess-1", {
    after: 0,
    onEvent: (e) => events.push(e),
    onDelta: (d) => deltas.push(d),
    signal: ctrl.signal,
  });

  await until(() => events.length === 2 && deltas.length === 2);
  expect(events.map((e) => e.seq)).toEqual([1, 2]);
  expect(events.map((e) => e.type)).toEqual(["message.received", "agent.message"]);
  // Delta text arrives cumulatively per call, in call order.
  expect(deltas).toEqual([
    { turn: 1, callNo: 1, text: "Hel" },
    { turn: 1, callNo: 1, text: "Hello" },
  ]);

  ctrl.abort();
  await done;
});

it("K2 the connection drops after seq 5: reconnects with ?after=5 after 0.5 s and never delivers an event twice", async () => {
  vi.useFakeTimers();
  const first = [
    eventFrame(1, "message.received", { platformMessageId: "pm-1" }),
    eventFrame(2, "message.received", { platformMessageId: "pm-2" }),
    eventFrame(3, "message.received", { platformMessageId: "pm-3" }),
    eventFrame(4, "message.received", { platformMessageId: "pm-4" }),
    eventFrame(5, "message.received", { platformMessageId: "pm-5" }),
  ].join("");
  const second = [
    eventFrame(6, "agent.message", { text: "a" }),
    eventFrame(7, "agent.message", { text: "b" }),
  ].join("");
  const fetchMock = fakeFetch([sseResponse(first), sseResponse(second)]);

  const events: SessionEvent[] = [];
  const ctrl = new AbortController();
  const done = followSession(fetchMock, "http://fabric.test", "sess-1", {
    after: 0,
    onEvent: (e) => events.push(e),
    onDelta: () => {},
    signal: ctrl.signal,
  });

  // The drop is noticed, then the reconnect waits out the 0.5 s backoff...
  await until(() => events.length === 5);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(400);
  expect(fetchMock).toHaveBeenCalledTimes(1); // still inside the backoff window
  await vi.advanceTimersByTimeAsync(200);
  expect(fetchMock).toHaveBeenCalledTimes(2); // fired by 0.5 s (600 ms here covers it)
  // ...and the reconnect resumes from the last seq seen.
  const secondUrl = String(fetchMock.mock.calls[1]?.[0]);
  expect(secondUrl).toMatch(/\/api\/sessions\/sess-1\/stream\?after=5$/);

  await until(() => events.length === 7);
  const seqs = events.map((e) => e.seq);
  expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(new Set(seqs).size).toBe(seqs.length);

  ctrl.abort();
  await done;
});

it("K3 reconnect backoff grows 0.5, 1, 2, 4, 10, 10 s across failures and resets after a connect", async () => {
  vi.useFakeTimers();
  const networkError = new Error("connection reset");
  // 6 failing connects, then a connect that succeeds but drops immediately, then a
  // failing connect (backoff must have reset to 0.5 s), then a hanging stream.
  const fetchMock = fakeFetch([
    networkError,
    networkError,
    networkError,
    networkError,
    networkError,
    networkError,
    sseResponse(""),
    networkError,
    hangingResponse(),
  ]);

  const ctrl = new AbortController();
  const done = followSession(fetchMock, "http://fabric.test", "sess-1", {
    onEvent: () => {},
    onDelta: () => {},
    signal: ctrl.signal,
  });

  const callsAfter = async (msByNow: number, expected: number) => {
    await vi.advanceTimersByTimeAsync(msByNow);
    expect(fetchMock).toHaveBeenCalledTimes(expected);
  };

  // Connect 1 fires immediately and fails; backoff 0.5 s before connect 2.
  await until(() => fetchMock.mock.calls.length === 1);
  await callsAfter(499, 1);
  await callsAfter(1, 2);
  // ...then 1 s, 2 s, 4 s, 10 s, and the cap 10 s.
  await callsAfter(999, 2);
  await callsAfter(1, 3);
  await callsAfter(1999, 3);
  await callsAfter(1, 4);
  await callsAfter(3999, 4);
  await callsAfter(1, 5);
  await callsAfter(9999, 5);
  await callsAfter(1, 6);
  await callsAfter(9999, 6);
  await callsAfter(1, 7); // connect 7 succeeds (empty stream) -> backoff resets
  // The drop after the successful connect waits 0.5 s again, not 10 s.
  await callsAfter(499, 7);
  await callsAfter(1, 8); // connect 8 fails; the ladder climbs from the reconnect count, not the cap
  await callsAfter(999, 8);
  await callsAfter(1, 9); // connect 9 hangs open

  ctrl.abort();
  await done;
});

it("K4 postMessage retries a network error with the same generated clientMessageId, and does not retry a 400", async () => {
  vi.useFakeTimers();
  // -- Generated id: stable across the retry.
  const failThenPost = fakeFetch([new Error("offline"), jsonResponse({ seq: 3 })]);
  const posting = postMessage(failThenPost, "http://fabric.test", "sess-9", { text: "hello" });
  for (let i = 0; i < 20 && failThenPost.mock.calls.length < 2; i++) await vi.advanceTimersByTimeAsync(100); // cover the 0.5 s retry backoff
  const seq = await posting;
  expect(seq).toEqual({ seq: 3 });
  expect(failThenPost).toHaveBeenCalledTimes(2);
  const [url1, init1] = failThenPost.mock.calls[0]!;
  const [url2, init2] = failThenPost.mock.calls[1]!;
  expect(String(url1)).toBe("http://fabric.test/api/sessions/sess-9/messages");
  expect(String(url2)).toBe("http://fabric.test/api/sessions/sess-9/messages");
  const body1 = JSON.parse(String(init1!.body)) as { clientMessageId: string; text: string };
  const body2 = JSON.parse(String(init2!.body)) as { clientMessageId: string; text: string };
  expect(body1.text).toBe("hello");
  expect(body1.clientMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(body2.clientMessageId).toBe(body1.clientMessageId);

  // -- 400 responses are final: one call, then the error.
  const badRequest = fakeFetch([jsonResponse({ error: "bad text" }, 400)]);
  await expect(postMessage(badRequest, "http://fabric.test", "sess-9", { clientMessageId: "3f9d6a67-9e3f-4d26-a1f2-0c5b2f4f7a10", text: "" })).rejects.toThrow();
  expect(badRequest).toHaveBeenCalledTimes(1);
  const [, retryInit] = badRequest.mock.calls[0]!;
  expect(JSON.parse(String(retryInit!.body)).clientMessageId).toBe("3f9d6a67-9e3f-4d26-a1f2-0c5b2f4f7a10");
});

it("K5 aborting the signal stops reconnecting and resolves the follow promise", async () => {
  vi.useFakeTimers();
  const first = [
    eventFrame(1, "message.received", { platformMessageId: "pm-1" }),
    eventFrame(2, "agent.message", { text: "done" }),
  ].join("");
  const fetchMock = fakeFetch([sseResponse(first)]);

  const events: SessionEvent[] = [];
  const ctrl = new AbortController();
  const done = followSession(fetchMock, "http://fabric.test", "sess-1", {
    after: 0,
    onEvent: (e) => events.push(e),
    onDelta: () => {},
    signal: ctrl.signal,
  });

  await until(() => events.length === 2);
  // The stream has dropped and a reconnect is pending: abort now.
  ctrl.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1); // no reconnect after the abort
  await done; // resolves (does not hang, does not reject)
});

it("K6 a frame split across three chunks parses into exactly one event", async () => {
  vi.useFakeTimers();
  const whole = eventFrame(1, "agent.message", { text: "split" });
  const cut = whole.indexOf(`data: `) + 6; // inside the frame, mid-JSON
  const cut2 = whole.length - 3; // inside the closing newline
  const fetchMock = fakeFetch([sseResponse(whole.slice(0, cut), whole.slice(cut, cut2), whole.slice(cut2)), hangingResponse()]);

  const events: SessionEvent[] = [];
  const ctrl = new AbortController();
  const done = followSession(fetchMock, "http://fabric.test", "sess-1", {
    after: 0,
    onEvent: (e) => events.push(e),
    onDelta: () => {},
    signal: ctrl.signal,
  });

  await until(() => events.length === 1, 50);
  expect(events).toHaveLength(1);
  expect(events[0]!.seq).toBe(1);

  ctrl.abort();
  await done;
});
