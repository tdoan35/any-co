import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider, toOpenAIMessages } from "./providers.ts";
import { runAgent } from "./run.ts";
import { SpendLedger, periodStart } from "./spend.ts";
import { resolveInWorkspace } from "./tools/impl.ts";
import type { ToolUseBlock } from "./types.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "agents");
const tmp = () => mkdtempSync(path.join(tmpdir(), "anyco-run-"));
const use = (name: string, input: Record<string, unknown>, id = name + Math.random()): ToolUseBlock => ({ type: "tool_use", id, name, input });

// good-agent: web_fetch allow, workspace_read allow, workspace_write ask, output { answer: string }.

test("tool loop: write is gated, read works, bad submit is rejected then fixed", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const runsDir = tmp();
  const fake = new FakeProvider([
    { content: [use("workspace_write", { path: "notes/a.txt", content: "hello" })] },
    { content: [use("workspace_read", { path: "." })] },
    { content: [use("submit_result", { answer: 42 })] },
    { content: [use("submit_result", { answer: "done" })] },
  ]);
  const approvals: string[] = [];
  const r = await runAgent(spec, {
    task: "test", provider: fake, naive: null, runsDir,
    approver: async (req) => { approvals.push(req.tool); return true; },
  });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, { answer: "done" });
  assert.deepEqual(approvals, ["workspace_write"]);
  assert.equal(readFileSync(path.join(r.dir, "workspace", "notes", "a.txt"), "utf8"), "hello");
  // turn 3's tool result told the model why its submit was rejected
  const lastMsg = fake.requests[3].messages.at(-1)!;
  assert.match(JSON.stringify(lastMsg), /rejected, fix and resubmit/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, "output.json"), "utf8")), { answer: "done" });
  assert.equal(r.spent_micro_usd, 4000);
  assert.equal(new SpendLedger(path.join(runsDir, "spend.jsonl")).total(new Date(0)), 4000);
  // the model sees exactly the granted tools plus submit_result
  assert.deepEqual(fake.requests[0].tools.map((t) => t.name).sort(), ["submit_result", "web_fetch", "workspace_read", "workspace_write"]);
});

test("declined approval and ungranted tools return errors to the model", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const fake = new FakeProvider([
    { content: [use("workspace_write", { path: "x", content: "y" }), use("catalog_meta", {})] },
    { content: [use("submit_result", { answer: "ok" })] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "done");
  const results = JSON.stringify(fake.requests[1].messages.at(-1));
  assert.match(results, /a human declined this action/);
  assert.match(results, /tool \\"catalog_meta\\" is not available to you/);
  assert.equal(existsSync(path.join(r.dir, "workspace", "x")), false);
});

test("a declined approval sends no email (the gate stops the tool before it runs)", async () => {
  const spec = await loadAgent("send-agent", FIX); // email_send: ask
  const sent: unknown[] = [];
  // Fake SDK client: records the send instead of reaching Naïve.
  const naive = { emails: { send: async (...a: unknown[]) => { sent.push(a); return { object: "email_send", accepted: true, from: "s@x.y", to: ["a@b.example"], sent_at: "t" }; } } } as never;
  const fake = new FakeProvider([
    { content: [use("email_send", { to: "press@example.com", subject: "s", body: "b" })] },
    { content: [use("submit_result", { ok: true })] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive, runsDir: tmp(), approver: async () => false });
  assert.equal(r.status, "done");
  assert.equal(sent.length, 0); // nothing left the machine
  assert.match(JSON.stringify(fake.requests[1].messages.at(-1)), /a human declined this action/);
});

test("a declined approval deploys nothing to the site", async () => {
  const spec = await loadAgent("send-agent", FIX); // site_deploy: ask
  const deploys: unknown[] = [];
  // Fake SDK client: records the deploy instead of reaching Naïve.
  const naive = { apps: { deploy: async (...a: unknown[]) => { deploys.push(a); return { id: "apd_x", status: "queued", url: null }; } } } as never;
  const fake = new FakeProvider([
    { content: [use("site_deploy", {})] },
    { content: [use("submit_result", { ok: true })] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive, runsDir: tmp(), approver: async () => false });
  assert.equal(r.status, "done");
  assert.equal(deploys.length, 0); // nothing left the machine
  assert.match(JSON.stringify(fake.requests[1].messages.at(-1)), /a human declined this action/);
});

test("T27: an itch_push dry run (explicit or defaulted) runs under an \"ask\" grant without an approval, and is ledgered as auto", async () => {
  const spec = await loadAgent("send-agent", FIX); // itch_push: ask
  for (const input of [{ dir: "web", target: "any-co/game:html5", build_id: "20261107-2115-abc1234", dry_run: true }, { dir: "web", target: "any-co/game:html5", build_id: "20261107-2115-abc1234" }]) {
    const asked: unknown[] = [];
    const runsDir = tmp();
    const fake = new FakeProvider([{ content: [use("itch_push", input)] }, { content: [use("submit_result", { ok: true })] }]);
    const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir, approver: async (req) => (asked.push(req), false) });
    assert.equal(r.status, "done");
    assert.equal(asked.length, 0, "no approval was requested for a dry run");
    const result = JSON.stringify(fake.requests[1].messages.at(-1));
    assert.doesNotMatch(result, /a human declined this action/);
    assert.match(result, /BUTLER_API_KEY|build_id|dist/, "the tool itself ran (and stopped on its own checks)");
    const ledger = readFileSync(path.join(runsDir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(ledger.map((e) => [e.kind, e.tool, e.decision, e.who]), [["approval", "itch_push", "approved", "auto (dry run: no approval needed)"]]);
  }
});

test("T27: a real itch_push (dry_run:false) still goes through the full ask gate", async () => {
  const spec = await loadAgent("send-agent", FIX);
  const asked: Array<{ tool: string; input: unknown }> = [];
  const fake = new FakeProvider([
    { content: [use("itch_push", { dir: "web", target: "any-co/game:html5", build_id: "20261107-2115-abc1234", dry_run: false })] },
    { content: [use("submit_result", { ok: true })] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp(), approver: async (req) => (asked.push(req), false) });
  assert.equal(r.status, "done");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, "itch_push");
  assert.match(JSON.stringify(fake.requests[1].messages.at(-1)), /a human declined this action/);
});

test("run stops at the per-run budget before overspending", async () => {
  const spec = await loadAgent("good-agent", FIX); // max_task_usd 0.5
  const fake = new FakeProvider(Array.from({ length: 10 }, () => ({ content: [use("workspace_read", {})] })), 200_000);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "budget_exceeded");
  assert.equal(r.turns, 2); // 2 × $0.20 spent; a 3rd $0.20 call could pass $0.50
  assert.ok(r.spent_micro_usd <= 500_000);
});

test("agent period cap counts earlier runs in the ledger", async () => {
  const spec = await loadAgent("good-agent", FIX); // cap_usd 2 per day
  const runsDir = tmp();
  new SpendLedger(path.join(runsDir, "spend.jsonl")).append({
    ts: new Date().toISOString(), run_id: "old", agent: "good-agent", kind: "model", what: "m", micro_usd: 2_000_000,
  });
  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "x" })] }]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir });
  assert.equal(r.status, "budget_exceeded");
  assert.equal(fake.requests.length, 0);
});

test("kill switch stops the run before any call", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const runsDir = tmp();
  writeFileSync(path.join(runsDir, "KILL"), "");
  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "x" })] }]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir });
  assert.equal(r.status, "killed");
  assert.equal(fake.requests.length, 0);
});

test("missing submit is nudged, then fails; max_turns is enforced", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const text = { content: [{ type: "text" as const, text: "I think the answer is 4" }] };
  const r = await runAgent(spec, { task: "t", provider: new FakeProvider([text, text, text]), naive: null, runsDir: tmp() });
  assert.equal(r.status, "error");
  assert.match(r.error!, /without calling submit_result/);

  const loop = new FakeProvider(Array.from({ length: 40 }, () => ({ content: [use("workspace_read", {})] })), 1);
  const r2 = await runAgent(spec, { task: "t", provider: loop, naive: null, runsDir: tmp() });
  assert.equal(r2.status, "max_turns");
  assert.equal(r2.turns, 30);
});

test("a max_tokens-truncated reply gets a specific recovery nudge, then can finish", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const fake = new FakeProvider([
    { content: [], stop_reason: "max_tokens" }, // whole reply discarded; nothing ran
    { content: [use("submit_result", { answer: "ok" })] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, { answer: "ok" });
  const nudge = fake.requests[1].messages.at(-1)!;
  assert.match(JSON.stringify(nudge), /output limit/);
  assert.match(JSON.stringify(nudge), /one tool call at a time/);
});

test("no-schema agent: an empty max_tokens reply is nudged, not taken as the final answer", async () => {
  const spec = { ...(await loadAgent("good-agent", FIX)), output_schema: undefined };
  const fake = new FakeProvider([
    { content: [], stop_reason: "max_tokens" }, // a reasoning model spent the whole limit thinking
    { content: [{ type: "text" as const, text: "cycle report" }] },
  ]);
  const r = await runAgent(spec as any, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "done");
  assert.equal(r.output, "cycle report");
  assert.match(JSON.stringify(fake.requests[1].messages.at(-1)), /output limit/);
});

test("provider errors end the run as error with the transcript saved", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const r = await runAgent(spec, { task: "t", provider: new FakeProvider([]), naive: null, runsDir: tmp() });
  assert.equal(r.status, "error");
  const lines = readFileSync(path.join(r.dir, "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "start");
  assert.equal(lines.at(-1).type, "end");
  assert.equal(JSON.parse(readFileSync(path.join(r.dir, "run.json"), "utf8")).status, "error");
});

test("workspace paths cannot escape", () => {
  const ws = "/tmp/ws";
  assert.equal(resolveInWorkspace(ws, "a/b.txt"), "/tmp/ws/a/b.txt");
  assert.throws(() => resolveInWorkspace(ws, "../etc/passwd"), /escapes/);
  assert.throws(() => resolveInWorkspace(ws, "/etc/passwd"), /escapes/);
});

test("period start: day, Monday-based week, month", () => {
  const thu = new Date(2026, 10, 12, 15, 30); // Thu Nov 12 2026
  assert.deepEqual(periodStart("day", thu), new Date(2026, 10, 12));
  assert.deepEqual(periodStart("week", thu), new Date(2026, 10, 9));
  assert.deepEqual(periodStart("month", thu), new Date(2026, 10, 1));
});

test("OpenAI translation keeps tool calls and results paired", () => {
  const msgs = toOpenAIMessages("sys", [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "looking" }, use("web_fetch", { url: "https://x.y" }, "c1")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "page" }] },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(msgs[2].tool_calls[0].id, "c1");
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"url":"https://x.y"}');
  assert.equal(msgs[3].tool_call_id, "c1");
});

test("catalog tools: required tags, string or list, stray args rejected", async () => {
  const { IMPLS } = await import("./tools/impl.ts");
  const niche = IMPLS.catalog_query.catalog_niche.input;
  assert.deepEqual((niche.parse({ tags: "A, B" }) as any).tags, ["A", "B"]);
  assert.deepEqual((niche.parse({ tags: ["A"] }) as any).tags, ["A"]);
  assert.deepEqual((niche.parse({ tags: '["Colony Sim", "Tower Defense"]' }) as any).tags, ["Colony Sim", "Tower Defense"]);
  assert.equal(niche.safeParse({ limit: 6, name: "x" }).success, false); // the run-2 failure shape
  assert.equal(niche.safeParse({ tags: "A,B,C,D" }).success, false);
  assert.equal(IMPLS.catalog_query.catalog_game.input.safeParse({}).success, false);
});

test("loop guard warns, then stops a run repeating one failing call", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const bad = () => ({ content: [use("workspace_read", { path: "../escape" }, "same")] });
  const fake = new FakeProvider(Array.from({ length: 10 }, bad));
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "stuck");
  assert.equal(r.turns, 5);
  assert.match(JSON.stringify(fake.requests[3].messages.at(-1)), /exact failing call 3 times/);
});

test("transient errors are retried, others are not", async () => {
  const { withRetry, isTransient } = await import("./providers.ts");
  assert.equal(isTransient(new TypeError("fetch failed")), true);
  assert.equal(isTransient({ status: 503 }), true);
  assert.equal(isTransient({ status: 400, message: "budget.exceeded" }), false);
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw new TypeError("fetch failed"); return "ok"; }, "t", 5, 1);
  assert.equal(v, "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error("bad"), { status: 400 }); }, "t", 5, 1));
  assert.equal(n, 1);
});

test("model-facing schemas carry bounds in descriptions, not as constraints", async () => {
  const { modelSafeSchema } = await import("./run.ts");
  const out: any = modelSafeSchema({ type: "object", properties: { s: { type: "number", minimum: 0, maximum: 1, description: "score" }, n: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 } } });
  assert.equal(out.properties.s.minimum, undefined);
  assert.equal(out.properties.s.description, "score Range: >= 0 and <= 1 (decimals allowed).");
  assert.equal(out.properties.n.description, undefined);
});

test("wrap-up: near the budget, only submit_result is offered and the run still ends with output", async () => {
  const spec = await loadAgent("good-agent", FIX); // max_task_usd 0.5
  const fake = new FakeProvider([
    { content: [use("workspace_read", {})] }, // $0.15 → headroom $0.35 < 3 × $0.15 → wrap-up
    (req) => {
      assert.ok(req.tools.some((t) => t.name === "workspace_read"), "tool list unchanged (keeps the prompt cache)");
      assert.match(JSON.stringify(req.messages.at(-1)), /nearly out of budget/);
      return { content: [use("workspace_read", {}), use("submit_result", { answer: "partial" })] };
    },
  ], 150_000);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, { answer: "partial" });
  // the wrap-up note joined the tool-result turn instead of adding a second user turn
  const roles = fake.requests[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  // the other tool call in the wrap-up turn was rejected, not run
  const tools = readFileSync(path.join(r.dir, "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "tool");
  assert.equal(tools.length, 1);
});

test("wrap-up starts at 70% of the run budget", async () => {
  const spec = await loadAgent("good-agent", FIX); // max_task_usd 0.5 → wrap-up once $0.35 is spent
  // Nine $0.04 calls = $0.36 spent (72%), while $0.14 left still covers 3 more calls: only the 70% rule fires.
  const fake = new FakeProvider([
    ...Array.from({ length: 9 }, (_, i) => ({ content: [use("workspace_read", {}, "r" + i)], cost_micro_usd: 40_000 })),
    (req) => { assert.match(JSON.stringify(req.messages.at(-1)), /nearly out of budget/); return { content: [use("submit_result", { answer: "ok" })], cost_micro_usd: 10_000 }; },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir: tmp() });
  assert.equal(r.status, "done");
  assert.equal(r.turns, 10);
});

test("salvage: over-long strings are trimmed; other errors are not", async () => {
  const { salvageTooLong } = await import("./run.ts");
  const { z } = await import("zod");
  const S = z.object({ gaps: z.array(z.object({ label: z.string().max(10), n: z.number() })) });
  const ok = salvageTooLong(S, { gaps: [{ label: "a very long label", n: 1 }, { label: "short", n: 2 }] });
  assert.ok(ok);
  assert.deepEqual(ok!.trimmed, ["gaps.0.label"]);
  assert.equal((ok!.data as any).gaps[0].label.length <= 10, true);
  assert.equal(salvageTooLong(S, { gaps: [{ label: "a very long label" }] }), null); // missing n: not salvageable
});
