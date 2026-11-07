// Chat with the Studio Head, end to end over HTTP + SSE, with a scripted provider (no network, no spend).
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrame, SessionMessagesSchema, type SessionEvent, type SessionFrame } from "@fabric/contracts";
import { FakeProvider } from "../../runner/providers.ts";
import type { ToolUseBlock } from "../../runner/types.ts";
import { ago, plainText } from "./chat.ts";
import { startServer } from "./index.ts";

const use = (name: string, input: Record<string, unknown>, id: string): ToolUseBlock => ({ type: "tool_use", id, name, input });
const POST = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Collects SSE frames from a session stream until the test is done. */
async function follow(url: string, after = 0) {
  const controller = new AbortController();
  const frames: SessionFrame[] = [];
  const res = await fetch(`${url}?after=${after}`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.trim()) frames.push(parseFrame(block));
        }
      }
    } catch { /* aborted */ }
  })();
  const events = () => frames.flatMap((f) => (f.event === "event" ? [f.data] : []));
  const waitFor = async (pred: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 4000) throw new Error(`timed out waiting for ${what}; got ${events().map((e) => e.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { frames, events, waitFor, stop: () => controller.abort() };
}

function world(opts: { provider?: FakeProvider; now?: () => Date; eventStart?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "window-chat-"));
  const ledgerFile = path.join(dir, "ledger.jsonl");
  const provider = opts.provider ?? new FakeProvider([{ content: [{ type: "text", text: "All quiet." }] }]);
  const boot = () => startServer({ runsDir: dir, port: 0, providerFor: () => provider, ledgerFile, eventStart: opts.eventStart, now: opts.now });
  return { dir, ledgerFile, provider, boot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("chat: a turn streams tool calls, one final agent.message, and keeps conversation memory", async () => {
  const w = world({
    provider: new FakeProvider([
      { content: [{ type: "text", text: "Let me check." }, use("studio_runs", {}, "call-1")] },
      { content: [{ type: "text", text: "Nothing is running." }] },
      { content: [{ type: "text", text: "Same as before." }] },
    ]),
  });
  const srv = await w.boot();
  const base = `http://127.0.0.1:${srv.port}/api`;
  try {
    const { sessionId } = await (await fetch(`${base}/sessions`, POST({ agentId: "studio-head" }))).json() as { sessionId: string };
    const f = await follow(`${base}/sessions/${sessionId}/stream`);
    const id1 = crypto.randomUUID();
    const { seq } = await (await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: id1, text: "what's running?" }))).json() as { seq: number };
    await f.waitFor(() => f.events().some((e) => e.type === "agent.message"), "the answer");

    const types = f.events().map((e) => e.type);
    assert.deepEqual(types, ["message.received", "tool.call", "tool.completed", "agent.message"]);
    assert.equal(f.events()[0].seq, seq);
    assert.equal((f.events().at(-1)!.payload as { text: string }).text, "Nothing is running.");
    // mid-turn narration came as a delta, not as a second agent.message
    const delta = f.frames.find((fr) => fr.event === "delta");
    assert.deepEqual(delta && delta.event === "delta" && delta.data.text, "Let me check.");
    assert.equal(types.filter((t) => t === "agent.message").length, 1);

    // the thread projection pairs the tool call with its result and validates against the UI contract
    const thread = SessionMessagesSchema.parse(await (await fetch(`${base}/sessions/${sessionId}/messages`)).json());
    assert.deepEqual(thread.messages.map((m) => m.role), ["user", "assistant"]);
    const parts = thread.messages[1].content;
    assert.equal(parts[0].type, "text");
    assert.equal(parts.find((p) => p.type === "tool-call")?.type, "tool-call");

    // idempotent: re-posting the same clientMessageId does not run another turn
    const again = await (await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: id1, text: "what's running?" }))).json() as { seq: number };
    assert.equal(again.seq, seq);
    assert.equal(w.provider.requests.length, 2);

    // second message: the model sees the first exchange as history
    await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: crypto.randomUUID(), text: "and now?" }));
    await f.waitFor(() => f.events().filter((e) => e.type === "agent.message").length === 2, "the second answer");
    const seen = w.provider.requests.at(-1)!.messages.map((m) => (typeof m.content === "string" ? m.content : "[blocks]"));
    assert.deepEqual(seen, ["what's running?", "Nothing is running.", "and now?"]);

    // the sidebar lists the thread; the turn is also a normal run on the Work page
    const reg = await (await fetch(`${base}/registry`)).json() as { sessions: Array<{ id: string; title: string; messages: number }> };
    assert.deepEqual(reg.sessions.map((s) => [s.id, s.title, s.messages]), [[sessionId, "what's running?", 4]]);
    assert.equal((reg.sessions[0] as unknown as { updated: string }).updated, "now");
    const runs = await (await fetch(`${base}/runs`)).json() as Array<{ id: string; teamId: string }>;
    assert.equal(runs.filter((r) => r.id.includes("studio-head")).length, 2);
    f.stop();
  } finally {
    await srv.close();
    w.cleanup();
  }
});

test("chat: interventions are ledgered only from the event start, with the message as the reason", async () => {
  let clock = new Date("2026-11-07T20:59:00Z"); // one minute before the 1 PM PT start
  const w = world({ now: () => clock });
  const srv = await w.boot();
  const base = `http://127.0.0.1:${srv.port}/api`;
  try {
    const { sessionId } = await (await fetch(`${base}/sessions`, POST({ agentId: "studio-head" }))).json() as { sessionId: string };
    const f = await follow(`${base}/sessions/${sessionId}/stream`);
    await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: crypto.randomUUID(), text: "practice question" }));
    await f.waitFor(() => f.events().some((e) => e.type === "agent.message"), "practice answer");
    assert.equal(existsSync(w.ledgerFile), false, "practice messages are not interventions");
    assert.equal((await (await fetch(`${base}/interventions`)).json() as { count: number }).count, 0);

    clock = new Date("2026-11-07T21:00:01Z");
    w.provider["steps"].push({ content: [{ type: "text", text: "ok" }] });
    await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: crypto.randomUUID(), text: "pause the art loop" }));
    await f.waitFor(() => f.events().filter((e) => e.type === "agent.message").length === 2, "second answer");
    const ledger = readFileSync(w.ledgerFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0], { kind: "intervention", ts: "2026-11-07T21:00:01.000Z", who: "operator", action: "chat message to studio-head", reason: "pause the art loop" });
    const summary = await (await fetch(`${base}/interventions`)).json() as { count: number; entries: Array<{ reason: string }> };
    assert.equal(summary.count, 1);
    assert.equal(summary.entries[0].reason, "pause the art loop");
    f.stop();
  } finally {
    await srv.close();
    w.cleanup();
  }
});

test("chat: a provider failure and a restart mid-turn both end in a reply, never a hung thread", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "window-chat-"));
  try {
    // a provider that cannot be built (e.g. no API key)
    const failing = await startServer({ runsDir: dir, port: 0, ledgerFile: path.join(dir, "l.jsonl"), providerFor: () => { throw new Error("NAIVE_API_KEY is not set"); } });
    const base = `http://127.0.0.1:${failing.port}/api`;
    const { sessionId } = await (await fetch(`${base}/sessions`, POST({ agentId: "studio-head" }))).json() as { sessionId: string };
    const f = await follow(`${base}/sessions/${sessionId}/stream`);
    await fetch(`${base}/sessions/${sessionId}/messages`, POST({ clientMessageId: crypto.randomUUID(), text: "hello" }));
    await f.waitFor(() => f.events().some((e) => e.type === "agent.message"), "the error reply");
    assert.match((f.events().at(-1)!.payload as { text: string }).text, /couldn't answer that: NAIVE_API_KEY is not set/);
    f.stop();
    await failing.close();

    // a crash between the human message and its answer is closed on the next start
    const orphan = path.join(dir, "chat", "s-orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "meta.json"), JSON.stringify({ agentId: "studio-head", incognito: false, createdAt: "2026-11-07T00:00:00Z" }));
    const ev: SessionEvent = { seq: 1, type: "message.received", class: "fact", payload: { text: "anyone there?", platformMessageId: "m1" }, ts: "2026-11-07T00:00:01Z" };
    appendFileSync(path.join(orphan, "events.jsonl"), JSON.stringify(ev) + "\n" + '{"seq":2,"type":"agent.mess'); // torn last line
    const restarted = await startServer({ runsDir: dir, port: 0, ledgerFile: path.join(dir, "l.jsonl"), providerFor: () => { throw new Error("unused"); } });
    const events = await (await fetch(`http://127.0.0.1:${restarted.port}/api/sessions/s-orphan/events`)).json() as SessionEvent[];
    assert.deepEqual(events.map((e) => e.type), ["message.received", "agent.message"]);
    assert.match((events[1].payload as { text: string }).text, /interrupted by a restart/);
    await restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server: other websites cannot call it, the window's own origins can, bad input is rejected", async () => {
  const w = world();
  const srv = await w.boot();
  const base = `http://127.0.0.1:${srv.port}/api`;
  try {
    const evil = await fetch(`${base}/registry`, { headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const evilPost = await fetch(`${base}/sessions`, POST({ agentId: "studio-head" }, { origin: "https://evil.example" }));
    assert.equal(evilPost.status, 403);
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5173", "app://fabric"]) {
      const ok = await fetch(`${base}/registry`, { headers: { origin } });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("access-control-allow-origin"), origin);
    }
    assert.equal((await fetch(`${base}/sessions`, POST({ agentId: "nobody" }))).status, 404);
    assert.equal((await fetch(`${base}/sessions`, POST({}))).status, 400);
    assert.equal((await fetch(`${base}/sessions/nope/messages`, POST({ clientMessageId: crypto.randomUUID(), text: "x" }))).status, 404);
    assert.equal((await fetch(`${base}/sessions/nope/stream`)).status, 404);
    assert.equal((await fetch(`${base}/runs`, POST({}))).status, 405);
    assert.equal((await fetch(`${base}/registry`, { method: "DELETE" })).status, 405);
  } finally {
    await srv.close();
    w.cleanup();
  }
});

test("ago: short relative times for the sidebar", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  assert.deepEqual(["2026-11-07T11:59:30Z", "2026-11-07T11:55:00Z", "2026-11-07T09:00:00Z", "2026-11-05T12:00:00Z"].map((t) => ago(t, now)), ["now", "5m", "3h", "2d"]);
});

test("plainText: strips markdown the chat window would show literally, keeps real content", () => {
  assert.equal(plainText("The priciest is **market-analyst**, at **$1.43**."), "The priciest is market-analyst, at $1.43.");
  assert.equal(plainText("## Summary\n* one\n* two with `code`"), "Summary\n- one\n- two with code");
  assert.equal(plainText("```ts\nlet a = 2 * 3;\n```"), "let a = 2 * 3;");
  assert.equal(plainText("see [docs](https://x.example/a) now"), "see docs (https://x.example/a) now");
  assert.equal(plainText("2 * 3 = 6 and snake_case_name stay"), "2 * 3 = 6 and snake_case_name stay");
  assert.equal(plainText("- already a list\n- fine"), "- already a list\n- fine");
});
