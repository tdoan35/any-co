// ANY-52 S3 — @fabric/contracts sessions: command schemas, SSE stream frames and
// the thread projection (ARCHITECTURE §10, RUNTIME §8). One test per listed case,
// named by its ID.
import { expect, it } from "vitest";
import type { SessionEvent } from "../sessions";
import { applyDelta, encodeFrame, parseFrame, projectThread, PostMessageRequestSchema } from "../sessions";

/** A well-formed session event; `payload` stays loose, as on the wire. */
const ev = (seq: number, type: string, payload: unknown = {}, ts = `2026-10-12T12:00:${String(seq).padStart(2, "0")}Z`): SessionEvent => ({
  seq,
  type,
  class: "fact",
  payload,
  ts,
});

const received = (seq: number, text: string, platformMessageId: string) =>
  ev(seq, "message.received", { text, attachments: [], surface: "app", sender: "dana", platformMessageId });

const agentMessage = (seq: number, text: string) => ev(seq, "agent.message", { text });

it("C1 PostMessageRequest rejects a non-uuid clientMessageId, empty text and text over 32000 chars", () => {
  const base = { clientMessageId: "3f9d6a67-9e3f-4d26-a1f2-0c5b2f4f7a10", text: "hello" };
  expect(PostMessageRequestSchema.parse(base)).toMatchObject(base);

  expect(() => PostMessageRequestSchema.parse({ ...base, clientMessageId: "not-a-uuid" })).toThrow();
  expect(() => PostMessageRequestSchema.parse({ ...base, text: "" })).toThrow();
  expect(() => PostMessageRequestSchema.parse({ ...base, text: "x".repeat(32001) })).toThrow();
});

it("C2 encodeFrame then parseFrame round-trips all three frame kinds, and an event frame's id: line is its seq", () => {
  const eventFrame = { event: "event", id: 7, data: ev(7, "agent.message", { text: "hi" }) } as const;
  const deltaFrame = { event: "delta", data: { turn: 1, callNo: 2, text: "Hel" } } as const;
  const pingFrame = { event: "ping" } as const;

  expect(parseFrame(encodeFrame(eventFrame))).toEqual(eventFrame);
  expect(parseFrame(encodeFrame(deltaFrame))).toEqual(deltaFrame);
  expect(parseFrame(encodeFrame(pingFrame))).toEqual(pingFrame);

  const wire = encodeFrame(eventFrame);
  const idLine = /^id: (\d+)$/m.exec(wire);
  expect(idLine).not.toBeNull();
  expect(Number(idLine![1])).toBe(eventFrame.id);
  expect(eventFrame.id).toBe(eventFrame.data.seq);
});

it("C3 projectThread on message.received, llm.completed, disposition.recorded, agent.message gives [user, assistant] with metadata.disposition.kind", () => {
  const messages = projectThread([
    received(1, "what time is it?", "pm-1"),
    ev(2, "llm.completed", { turn: 1, callNo: 1, text: "", toolCalls: [], finishReason: "stop", model: "m" }),
    ev(3, "disposition.recorded", { kind: "direct", target: null, reason: "simple question" }),
    agentMessage(4, "It is noon."),
  ]);

  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "what time is it?" }] });
  expect(messages[1]?.role).toBe("assistant");
  expect(messages[1]?.content[0]).toEqual({ type: "text", text: "It is noon." });
  expect(messages[1]?.metadata?.disposition?.kind).toBe("direct");
});

it("C4 a tool call is a running part, done after tool.completed; interrupted and denied resolve likewise", () => {
  const call = ev(1, "tool.call", { tool: "shell", summary: "ls", callId: "c1" });
  const done = ev(2, "tool.completed", { callId: "c1", ok: true, result: "files" });
  const interrupted = ev(2, "tool.interrupted", { callId: "c1", effect: "rerunnable", note: "sigterm" });
  const denied = ev(2, "tool.denied", { tool: "shell", target: "/etc", reason: "no grant", callId: "c1" });
  const turn = agentMessage(3, "listed.");

  const partOf = (events: SessionEvent[]) => {
    const messages = projectThread(events);
    const assistant = messages.find((m) => m.role === "assistant");
    return assistant?.content.find((p) => p.type === "tool-call");
  };

  expect(partOf([call, turn])).toMatchObject({ toolName: "shell", status: "running" });
  expect(partOf([call, done, turn])).toMatchObject({ status: "done", result: "files" });
  expect(partOf([call, interrupted, turn])).toMatchObject({ status: "interrupted" });
  expect(partOf([call, denied, turn])).toMatchObject({ status: "denied" });
});

it("C5 an open human.requested is a pending-ask part; after human.responded it is answered", () => {
  const ask = ev(1, "human.requested", { waitId: "w1", kind: "confirm", gated: true, prompt: "Deploy now?", deadline: null });
  const response = ev(2, "human.responded", { waitId: "w1", decision: "yes", by: "ty", surface: "app" });

  const askPartOf = (events: SessionEvent[]) => {
    for (const message of projectThread(events))
      for (const part of message.content) if (part.type === "ask-human" && part.waitId === "w1") return part;
    return undefined;
  };

  expect(askPartOf([ask])).toMatchObject({ prompt: "Deploy now?" });
  expect(askPartOf([ask])?.response).toBeUndefined();
  expect(askPartOf([ask, response])?.response).toEqual({ decision: "yes", by: "ty" });
});

it("C6 applyDelta twice for one call keeps a single provisional with the latest text; projectThread with the turn's agent.message has no provisional", () => {
  const once = applyDelta([], { turn: 1, callNo: 1, text: "Hel" });
  const twice = applyDelta(once, { turn: 1, callNo: 1, text: "Hello" });

  expect(twice).toHaveLength(1);
  expect(twice[0]).toMatchObject({
    role: "assistant",
    provisional: { turn: 1, callNo: 1 },
    content: [{ type: "text", text: "Hello" }],
  });

  const projected = projectThread([received(1, "hi", "pm-1"), agentMessage(2, "Hello")]);
  expect(projected.some((m) => m.provisional)).toBe(false);
  expect(projected[1]?.content[0]).toEqual({ type: "text", text: "Hello" });
});

it("C7 out-of-order and duplicated events project the same as the clean sequence", () => {
  const clean = [
    received(1, "run the tests", "pm-1"),
    ev(2, "tool.call", { tool: "shell", summary: "npm t", callId: "c1" }),
    ev(3, "tool.completed", { callId: "c1", ok: true }),
    agentMessage(4, "green."),
  ];
  const messy = [clean[3]!, clean[2]!, clean[2]!, clean[1]!, clean[0]!, clean[3]!];

    expect(projectThread(messy)).toEqual(projectThread(clean));
});

it("C8 unknown event types are ignored and the projection does not throw", () => {
  const known = [received(1, "hi", "pm-1"), agentMessage(2, "Hello")];
  const withUnknown = [
    ev(0, "future.thing", { anything: true, nested: { deep: [1, 2] } }),
    ...known,
    ev(5, "another.unknown"),
  ];

  let projected: ReturnType<typeof projectThread>;
  expect(() => {
    projected = projectThread(withUnknown);
  }).not.toThrow();
  expect(projected!).toEqual(projectThread(known));
});
