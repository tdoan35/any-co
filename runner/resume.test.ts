import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, specHash } from "./load.ts";
import { FakeProvider } from "./providers.ts";
import { runAgent } from "./run.ts";
import { readEvents, rebuildConversation, resumeRun } from "./resume.ts";
import { listOrphans, orphanAfterMin, orphanStatus, pidAlive } from "./liveness.ts";
import { SpendLedger } from "./spend.ts";
import type { ToolUseBlock } from "./types.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "agents");
const CRASH = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "crash-run.ts");
const tmp = () => mkdtempSync(path.join(tmpdir(), "anyco-resume-"));
const use = (name: string, input: Record<string, unknown>, id: string): ToolUseBlock => ({ type: "tool_use", id, name, input });
const steps = [
  { content: [use("workspace_write", { path: "notes/a.txt", content: "hello" }, "w1")] },
  { content: [use("submit_result", { answer: "done" }, "s1")] },
];

/** A genuinely crashed run: child runs good-agent, SIGKILLs itself at the chosen event. */
const crashChild = (runsDir: string, killAt: string, approveAll = true) =>
  spawnSync(process.execPath, ["--import", "tsx", CRASH, runsDir, killAt, JSON.stringify(steps), approveAll ? "1" : "0"], { encoding: "utf8" });
const onlyRun = (runsDir: string) => readdirSync(runsDir).filter((n) => n !== "spend.jsonl")[0];

test("crash after a model reply: resume finishes the run with the same output", async () => {
  const spec = await loadAgent("good-agent", FIX);

  // Uninterrupted baseline with the same scripted turns.
  const base = await runAgent(spec, { task: "crash test", provider: new FakeProvider(structuredClone(steps)), naive: null, runsDir: tmp(), approver: async () => true });
  assert.equal(base.status, "done");
  assert.deepEqual(base.output, { answer: "done" });
  const baseRun = JSON.parse(readFileSync(path.join(base.dir, "run.json"), "utf8"));
  assert.equal(baseRun.pid, process.pid); // liveness fields are recorded
  assert.equal(baseRun.host, hostname());
  assert.ok(baseRun.heartbeat_at);

  // Crash right after the first assistant message is recorded.
  const runsDir = tmp();
  const child = crashChild(runsDir, "msg:assistant");
  assert.equal(child.signal, "SIGKILL");
  const runId = onlyRun(runsDir);
  const stuck = JSON.parse(readFileSync(path.join(runsDir, runId, "run.json"), "utf8"));
  assert.equal(stuck.status, "running"); // no finalize happened
  assert.equal(readEvents(path.join(runsDir, runId)).some((e) => e.type === "end"), false);

  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "done" }, "s2")] }]);
  const r = await resumeRun(spec, runId, { provider: fake, naive: null, runsDir, approver: async () => true });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, base.output);
  assert.equal(r.run_id, runId);
  assert.equal(r.turns, base.turns);
  assert.equal(r.spent_micro_usd, base.spent_micro_usd);

  // The interrupted write was never executed and is not re-executed: the model gets the notice.
  assert.equal(existsSync(path.join(runsDir, runId, "workspace", "notes", "a.txt")), false);
  const last = fake.requests[0].messages.at(-1)!;
  assert.match(JSON.stringify(last), /interrupted by a crash; check the current state before retrying/);

  const events = readEvents(path.join(runsDir, runId));
  const resume = events.find((e) => e.type === "resume");
  assert.equal(resume?.from_turn, 1);
  const mine = new SpendLedger(path.join(runsDir, "spend.jsonl")).entries().filter((e) => e.run_id === runId);
  assert.equal(mine.length, 2); // one model call before the crash, one after — spend continues
  assert.equal(r.spent_micro_usd, mine.reduce((s, e) => s + e.micro_usd, 0));
});

test("crash mid tool call (after approval, before the result): no re-execution, error result sent", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const runsDir = tmp();
  const child = crashChild(runsDir, "approval:workspace_write");
  assert.equal(child.signal, "SIGKILL");
  const runId = onlyRun(runsDir);

  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "ok" }, "s2")] }]);
  const r = await resumeRun(spec, runId, { provider: fake, naive: null, runsDir, approver: async () => true });
  assert.equal(r.status, "done");
  assert.equal(existsSync(path.join(runsDir, runId, "workspace", "notes", "a.txt")), false); // never fired
  const events = readEvents(path.join(runsDir, runId));
  assert.equal(events.filter((e) => e.type === "approval").length, 1); // approval never re-asked
  assert.equal(events.filter((e) => e.type === "tool" && e.id === "w1").length, 0); // never re-executed
  assert.match(JSON.stringify(fake.requests[0].messages.at(-1)), /interrupted by a crash/);
});

test("a tool result that was recorded but never delivered is replayed verbatim, not re-run", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const runsDir = tmp();
  const child = crashChild(runsDir, "tool:workspace_write"); // kill right after the tool event
  assert.equal(child.signal, "SIGKILL");
  const runId = onlyRun(runsDir);
  const file = path.join(runsDir, runId, "workspace", "notes", "a.txt");
  assert.equal(readFileSync(file, "utf8"), "hello"); // the side effect survived the crash

  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "ok" }, "s2")] }]);
  const r = await resumeRun(spec, runId, { provider: fake, naive: null, runsDir, approver: async () => true });
  assert.equal(r.status, "done");
  assert.equal(readFileSync(file, "utf8"), "hello");
  // The model sees the recorded result, not a crash notice, and the call ran exactly once.
  assert.match(JSON.stringify(fake.requests[0].messages.at(-1)), /wrote notes\/a\.txt \(5 chars\)/);
  const events = readEvents(path.join(runsDir, runId));
  assert.equal(events.filter((e) => e.type === "tool" && e.id === "w1").length, 1);
});

test("orphan detection: dead pid, stale heartbeat, live, finished, foreign host, old format", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]); // a real pid that no longer exists
  assert.equal(pidAlive(dead.pid), false);
  const now = new Date();
  const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  assert.equal(orphanStatus({ status: "running", pid: dead.pid, host: hostname(), heartbeat_at: iso(0) }, now).orphaned, true);
  assert.equal(orphanStatus({ status: "running", pid: process.pid, host: hostname(), heartbeat_at: iso(11) }, now).orphaned, true);
  assert.equal(orphanStatus({ status: "running", pid: process.pid, host: hostname(), heartbeat_at: iso(0) }, now).orphaned, false);
  assert.equal(orphanStatus({ status: "done", pid: dead.pid, host: hostname(), heartbeat_at: iso(60) }, now).orphaned, false);
  assert.equal(orphanStatus({ status: "running", pid: 4711, host: "some-other-host", heartbeat_at: iso(0) }, now).orphaned, false);
  assert.equal(orphanStatus({ status: "running", pid: 4711, host: "some-other-host", heartbeat_at: iso(11) }, now).orphaned, true);
  assert.equal(orphanStatus({ status: "running" }, now).orphaned, true); // pre-liveness run: nothing to prove life with

  assert.equal(orphanAfterMin(), 10);
  const prev = process.env.STUDIO_ORPHAN_AFTER_MIN;
  try {
    process.env.STUDIO_ORPHAN_AFTER_MIN = "0.01"; // < 1 min: a 5s-old heartbeat is already stale
    assert.equal(orphanStatus({ status: "running", pid: process.pid, host: hostname(), heartbeat_at: new Date(now.getTime() - 5000).toISOString() }, now).orphaned, true);
    process.env.STUDIO_ORPHAN_AFTER_MIN = "junk";
    assert.equal(orphanAfterMin(), 10);
  } finally {
    if (prev === undefined) delete process.env.STUDIO_ORPHAN_AFTER_MIN;
    else process.env.STUDIO_ORPHAN_AFTER_MIN = prev;
  }
});

test("listOrphans reports only stuck runs, with their facts", () => {
  const runsDir = tmp();
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const mk = (id: string, run: Record<string, unknown>) => {
    mkdirSync(path.join(runsDir, id), { recursive: true });
    writeFileSync(path.join(runsDir, id, "run.json"), JSON.stringify(run));
  };
  mk("r-stuck", { status: "running", pid: dead.pid, host: hostname(), heartbeat_at: new Date().toISOString(), agent: "good-agent", turns: 3, spent_micro_usd: 1200 });
  mk("r-live", { status: "running", pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString() });
  mk("r-done", { status: "done", pid: dead.pid, host: hostname(), heartbeat_at: new Date().toISOString() });
  const orphans = listOrphans(runsDir);
  assert.deepEqual(orphans.map((o) => o.run_id), ["r-stuck"]);
  assert.equal(orphans[0].agent, "good-agent");
  assert.equal(orphans[0].turns, 3);
  assert.equal(orphans[0].spent_micro_usd, 1200);
  assert.match(orphans[0].reason, /not alive/);
});

test("resume refuses finished, live, foreign-spec, unprovable and corrupt runs", async () => {
  const spec = await loadAgent("good-agent", FIX);

  // Finished run.
  const done = await runAgent(spec, { task: "t", provider: new FakeProvider([{ content: [use("submit_result", { answer: "x" }, "s1")] }]), naive: null, runsDir: tmp() });
  await assert.rejects(resumeRun(spec, done.run_id, { provider: new FakeProvider([]), naive: null, runsDir: path.dirname(done.dir) }), /finished with status "done"/);

  // Crafted run dirs for the remaining refusals.
  const runsDir = tmp();
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const mk = (id: string, run: Record<string, unknown>, lines: unknown[] = []) => {
    mkdirSync(path.join(runsDir, id), { recursive: true });
    writeFileSync(path.join(runsDir, id, "run.json"), JSON.stringify({ agent: "good-agent", spec_hash: specHash(spec), status: "running", started_at: new Date().toISOString(), ...run }));
    writeFileSync(path.join(runsDir, id, "transcript.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const start = { ts: new Date().toISOString(), type: "start", task: "t", history: [] };
  const alive = { pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString() };

  mk("r-alive", alive, [start]);
  await assert.rejects(resumeRun(spec, "r-alive", { provider: new FakeProvider([]), naive: null, runsDir }), /still looks alive/);

  mk("r-other-agent", { agent: "someone-else", ...alive }, [start]);
  await assert.rejects(resumeRun(spec, "r-other-agent", { provider: new FakeProvider([]), naive: null, runsDir }), /belongs to agent "someone-else"/);

  mk("r-spec-changed", { spec_hash: "deadbeefdeadbeef", ...alive }, [start]);
  await assert.rejects(resumeRun(spec, "r-spec-changed", { provider: new FakeProvider([]), naive: null, runsDir }), /changed since the crash/);

  mk("r-empty", { pid: dead.pid, host: hostname(), heartbeat_at: new Date().toISOString() }, []);
  await assert.rejects(resumeRun(spec, "r-empty", { provider: new FakeProvider([]), naive: null, runsDir }), /no start event/);

  // Old-format transcript: turns happened but messages were never recorded.
  mk("r-old", { pid: dead.pid, host: hostname(), heartbeat_at: new Date().toISOString() }, [
    start,
    { ts: new Date().toISOString(), type: "request", turn: 1 },
    { ts: new Date().toISOString(), type: "reply", content: [] },
  ]);
  await assert.rejects(resumeRun(spec, "r-old", { provider: new FakeProvider([]), naive: null, runsDir }), /cannot be rebuilt exactly/);

  // Corruption in the middle of the file.
  mkdirSync(path.join(runsDir, "r-corrupt"), { recursive: true });
  writeFileSync(path.join(runsDir, "r-corrupt", "run.json"), JSON.stringify({ agent: "good-agent", spec_hash: specHash(spec), status: "running", pid: dead.pid, host: hostname(), heartbeat_at: new Date().toISOString() }));
  writeFileSync(path.join(runsDir, "r-corrupt", "transcript.jsonl"), `${JSON.stringify(start)}\nnot json at all\n${JSON.stringify({ type: "msg", role: "assistant", content: [] })}\n`);
  await assert.rejects(resumeRun(spec, "r-corrupt", { provider: new FakeProvider([]), naive: null, runsDir }), /corrupt/);

  // A torn last line is expected after a crash and must not refuse the resume by itself.
  const runsDir2 = tmp();
  const child = crashChild(runsDir2, "msg:assistant");
  assert.equal(child.signal, "SIGKILL");
  const runId = onlyRun(runsDir2);
  const file = path.join(runsDir2, runId, "transcript.jsonl");
  const whole = readFileSync(file, "utf8");
  writeFileSync(file, whole + '{"ts":"2026-11-07T21:00:00.000Z","type":"msg","role":"assistant","content":[{"type":"text","t'); // torn mid-write
  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "ok" }, "s2")] }]);
  const r = await resumeRun(spec, runId, { provider: fake, naive: null, runsDir: runsDir2, approver: async () => true });
  assert.equal(r.status, "done");
});

test("spend continues across a resume and the run cap still stops it", async () => {
  const spec = await loadAgent("good-agent", FIX);
  const runsDir = tmp();
  const child = crashChild(runsDir, "msg:assistant"); // one model call spent: 1000 micro-USD
  assert.equal(child.signal, "SIGKILL");
  const runId = onlyRun(runsDir);

  // Cap of 1500 with 1000 spent: headroom (500) is below the most expensive call (1000).
  const r = await resumeRun(spec, runId, { provider: new FakeProvider([], 2000), naive: null, runsDir, runCapUsd: 0.0015, approver: async () => true });
  assert.equal(r.status, "budget_exceeded");
  assert.equal(r.turns, 1);
  assert.equal(r.spent_micro_usd, 1000);
  const mine = new SpendLedger(path.join(runsDir, "spend.jsonl")).entries().filter((e) => e.run_id === runId);
  assert.equal(mine.length, 1); // nothing new was spent
});

test("rebuildConversation replays history, task, messages and notes exactly", () => {
  const events = [
    { ts: "t0", type: "start", task: "do it", history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "hi" }] },
    { ts: "t1", type: "request", turn: 1 },
    { ts: "t2", type: "msg", role: "assistant", content: [{ type: "text", text: "working" }] },
    { ts: "t3", type: "msg", role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "wrote x" }] },
    { ts: "t4", type: "note", text: "wrap up" },
    { ts: "t5", type: "wrap_up", turn: 1, why: "budget" },
    { ts: "t6", type: "request", turn: 2 },
    { ts: "t7", type: "msg", role: "assistant", content: [{ type: "tool_use", id: "s1", name: "submit_result", input: { answer: "x" } }] },
  ];
  const c = rebuildConversation(events);
  assert.deepEqual(c.messages, [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "do it" },
    { role: "assistant", content: [{ type: "text", text: "working" }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "w1", content: "wrote x" },
      { type: "text", text: "wrap up" },
    ] },
    { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "submit_result", input: { answer: "x" } }] },
  ]);
  assert.equal(c.turns, 2);
  assert.equal(c.wrapUp, true);
  assert.equal(c.task, "do it");
});
