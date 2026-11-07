// Chat support in the runner: prior-turn history, the onEvent hook, call ids on tool events, and the
// read-only studio_status tools. Uses a throwaway agents dir so the shared fixtures stay unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider } from "./providers.ts";
import { runAgent } from "./run.ts";
import type { ToolUseBlock } from "./types.ts";

const SPEC_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "spec.ts");
const use = (name: string, input: Record<string, unknown>, id: string): ToolUseBlock => ({ type: "tool_use", id, name, input });

async function chatSpec() {
  const agents = mkdtempSync(path.join(tmpdir(), "anyco-agents-"));
  const dir = path.join(agents, "chat-agent");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "spec.ts"), `import { defineAgent } from ${JSON.stringify(SPEC_TS)};
export default defineAgent({ name: "chat-agent", description: "Fixture: a conversational agent.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" }, tools: { studio_status: "allow" } });\n`);
  writeFileSync(path.join(dir, "system.md"), "You are a fixture agent used only by tests. Answer briefly and truthfully.");
  return loadAgent("chat-agent", agents);
}

function fakeRuns() {
  const runsDir = mkdtempSync(path.join(tmpdir(), "anyco-runs-"));
  mkdirSync(path.join(runsDir, "20261107-000000-market-analyst"));
  writeFileSync(path.join(runsDir, "20261107-000000-market-analyst", "run.json"), JSON.stringify({
    agent: "market-analyst", status: "done", turns: 3, spent_micro_usd: 123456, started_at: "2026-11-07T00:00:00Z", task: "find gaps",
  }));
  writeFileSync(path.join(runsDir, "20261107-000000-market-analyst", "output.json"), JSON.stringify({ gaps: ["x"] }));
  mkdirSync(path.join(runsDir, "chat")); // chat sessions live here and are not runs
  writeFileSync(path.join(runsDir, "spend.jsonl"),
    JSON.stringify({ ts: "2026-11-07T00:00:01Z", run_id: "r", agent: "market-analyst", kind: "model", what: "m", micro_usd: 1000 }) + "\n" +
    JSON.stringify({ ts: "2026-11-07T00:00:02Z", run_id: "r", agent: "feasibility-critic", kind: "model", what: "m", micro_usd: 500 }) + "\n");
  return runsDir;
}

test("history precedes the new message, onEvent sees events live, and tool events carry the call id", async () => {
  const spec = await chatSpec();
  const runsDir = fakeRuns();
  const fake = new FakeProvider([
    { content: [use("studio_runs", {}, "call-1")] },
    { content: [{ type: "text", text: "One run finished." }] },
  ]);
  const seen: string[] = [];
  const r = await runAgent(spec, {
    task: "what is running?", provider: fake, naive: null, runsDir,
    history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    onEvent: (type) => { seen.push(type); if (type === "reply") throw new Error("listener errors must not stop the run"); },
  });
  assert.equal(r.status, "done");
  assert.equal(r.output, "One run finished.");
  // history first, then the task, in order
  assert.deepEqual(fake.requests[0].messages.map((m) => m.content), ["hi", "hello", "what is running?"]);
  assert.deepEqual(seen.filter((t) => t !== "request" && t !== "reply"), ["start", "tool", "end"]);
  const tool = readFileSync(path.join(r.dir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "tool");
  assert.equal(tool.id, "call-1");
  // studio_runs listed the fake run and skipped the chat dir
  const result = JSON.stringify(fake.requests[1].messages.at(-1));
  assert.match(result, /20261107-000000-market-analyst/);
  assert.doesNotMatch(result, /\\"id\\":\\"chat\\"/);
});

test("studio_run returns the output, a bad id is an error the model can read, studio_spend totals per agent", async () => {
  const spec = await chatSpec();
  const runsDir = fakeRuns();
  const fake = new FakeProvider([
    { content: [use("studio_run", { run_id: "20261107-000000-market-analyst" }, "a"), use("studio_run", { run_id: "nope-nope" }, "b"), use("studio_spend", {}, "c")] },
    { content: [{ type: "text", text: "done" }] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir });
  assert.equal(r.status, "done");
  const results = (fake.requests[1].messages.at(-1)!.content as Array<{ content: string; is_error?: boolean }>);
  assert.match(results[0].content, /"gaps":\["x"\]/);
  assert.match(results[0].content, /"cost_usd":0.123456/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /no run "nope-nope"/);
  const spend = JSON.parse(results[2].content);
  // the two seeded entries, plus this run's own first model call (1000 micro-USD) charged before the tool ran
  assert.equal(spend.total_usd, 0.0025);
  assert.deepEqual(spend.by_agent_usd, { "market-analyst": 0.001, "feasibility-critic": 0.0005, "chat-agent": 0.001 });
});
