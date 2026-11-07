import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider } from "./providers.ts";
import { Dispatcher, acquireStudioLock } from "./dispatch.ts";
import { hostname } from "node:os";
import type { Board } from "./board/index.ts";
import { LocalBoard } from "./board/local.ts";
import type { ModelReply, Provider, ToolUseBlock } from "./types.ts";
import { TOOL_INDEX } from "./tools/impl.ts";
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "dispatch-agents");

const tmpDir = () => mkdtempSync(path.join(tmpdir(), "anyco-dispatch-"));

/** A provider whose first reply submits a valid result; records the task it was given. */
const scripted = () => {
  const submit: ToolUseBlock = { type: "tool_use", id: "s1", name: "submit_result", input: { answer: "ok" } };
  return new FakeProvider([{ content: [submit] }]);
};

async function rig(over: { maxParallel?: number } = {}) {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([
    ["alpha-agent", await loadAgent("alpha-agent", FIX)],
    ["beta-agent", await loadAgent("beta-agent", FIX)],
  ]);
  const providers: FakeProvider[] = [];
  const d = new Dispatcher({
    board,
    specs,
    provider: () => {
      const p = scripted();
      providers.push(p);
      return p;
    },
    runsDir,
    ...over,
  });
  return { d, board, providers, runsDir };
}

const taskOf = (p: FakeProvider): string => String(p.requests[0].messages.at(-1)?.content);

test("dispatches a due card and closes it done with status, run id, spend and a summary", async () => {
  const { d, board } = await rig();
  const { card } = await board.create({ title: "Survey the niche", body: "Numbers only.", assignee: "alpha-agent" });
  const res = await d.pass();
  assert.equal(res.started, 1);
  await d.wait();
  const done = await board.get(card.id);
  assert.equal(done.status, "done");
  assert.match(done.note!, /^done: run .+-alpha-agent, \$0\.00\d+ — \{"answer":"ok"\}$/);
});

test("dependency ordering: a blocked card waits, then its task carries the blocker's done note", async () => {
  const { d, board, providers } = await rig({ maxParallel: 4 });
  const a = await board.create({ title: "Pick the game", assignee: "alpha-agent" });
  const b = await board.create({ title: "Plan the demo", assignee: "beta-agent", blocked_by: [a.card.id] });
  let res = await d.pass();
  assert.equal(res.started, 1); // only A: B is blocked
  await d.wait();
  assert.equal((await board.get(b.card.id)).status, "todo"); // healed once A is done
  res = await d.pass();
  assert.equal(res.started, 1); // now B
  await d.wait();
  const task = taskOf(providers[1]);
  assert.match(task, /# Plan the demo/);
  assert.match(task, /--- Upstream results/);
  assert.match(task, /## Pick the game/);
  assert.match(task, /done: run .+-alpha-agent/); // A's done note is B's context
});

test("one card per agent: the second card for a busy agent waits for a later pass", async () => {
  const { d, board } = await rig({ maxParallel: 4 });
  const one = await board.create({ title: "First", assignee: "alpha-agent" });
  const two = await board.create({ title: "Second", assignee: "alpha-agent" });
  let res = await d.pass();
  assert.equal(res.started, 1);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0], /already holds a doing card/); // whichever card lost the race
  await d.wait();
  res = await d.pass();
  assert.equal(res.started, 1);
  await d.wait();
  assert.equal((await board.get(one.card.id)).status, "done");
  assert.equal((await board.get(two.card.id)).status, "done");
});

test("max-parallel bounds in-flight runs across agents", async () => {
  const { d, board } = await rig({ maxParallel: 1 });
  await board.create({ title: "A", assignee: "alpha-agent" });
  await board.create({ title: "B", assignee: "beta-agent" });
  const res = await d.pass();
  assert.equal(res.started, 1);
  assert.equal(d.busy, 1);
  await d.wait();
  const next = await d.pass();
  assert.equal(next.started, 1);
  await d.wait();
  assert.equal((await board.list()).every((c) => c.status === "done"), true);
});

test("a failed run blocks the card with the error; a killed run requeues to todo", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([["alpha-agent", await loadAgent("alpha-agent", FIX)]]);
  // no scripted steps: the run errors out ("ended without calling submit_result")
  const d = new Dispatcher({ board, specs, provider: () => new FakeProvider([]), runsDir });
  const fail = await board.create({ title: "Fails", assignee: "alpha-agent" });
  await d.pass();
  await d.wait();
  assert.equal((await board.get(fail.card.id)).status, "blocked");
  assert.match((await board.get(fail.card.id)).note!, /^error: run /);

  // killed: hold the run inside its first model call, throw the switch, then let it go —
  // the runner stops at the top of its next turn with status "killed"
  const gate = Promise.withResolvers<void>();
  const gated: Provider = {
    label: "gated",
    async complete(): Promise<ModelReply> {
      await gate.promise;
      return {
        content: [{ type: "text", text: "still working" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_micro_usd: 0,
        request_id: "gated_1",
        model: "gated",
      };
    },
  };
  const d2 = new Dispatcher({ board, specs, provider: () => gated, runsDir });
  const killed = await board.create({ title: "Killed", assignee: "alpha-agent" });
  await d2.pass();
  assert.equal(d2.busy, 1); // the run is in flight, parked in the provider
  writeFileSync(path.join(runsDir, "KILL"), "");
  gate.resolve();
  await d2.wait();
  const after = await board.get(killed.card.id);
  assert.equal(after.status, "todo");
  assert.ok((await board.comments(killed.card.id)).some((c) => c.body.includes("kill switch")));
});

test("restart safety: an orphaned doing card is requeued to todo with a comment", async () => {
  const { d, board } = await rig();
  const { card } = await board.create({ title: "Interrupted", assignee: "alpha-agent" });
  await board.update(card.id, { status: "doing" });
  const requeued = await d.requeueOrphans();
  assert.equal(requeued, 1);
  const after = await board.get(card.id);
  assert.equal(after.status, "todo");
  assert.ok((await board.comments(card.id)).some((c) => c.body.includes("no live run")));
  // and the resume hook (T5) can claim it instead
  const { card: owned } = await board.create({ title: "Resumable", assignee: "beta-agent" });
  await board.update(owned.id, { status: "doing" });
  const kept = await new Dispatcher({
    board,
    specs: d.opts.specs,
    provider: () => scripted(),
    onResumeOrphan: async (c) => c.id === owned.id,
  }).requeueOrphans();
  assert.equal(kept, 0);
  assert.equal((await board.get(owned.id)).status, "doing");
});

test("kill switch stops dispatch between passes", async () => {
  const { d, board, runsDir } = await rig();
  await board.create({ title: "Never started", assignee: "alpha-agent" });
  writeFileSync(path.join(runsDir, "KILL"), "");
  const res = await d.pass();
  assert.equal(res.killed, true);
  assert.equal(res.started, 0);
  const cards = await board.list();
  assert.equal(cards[0].status, "todo"); // untouched
});

test("board tools: unknown assignee and unknown blockers are refused; a valid create lands", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const ctx = { workspace: runsDir, naive: null, board, agentsDir: FIX };
  const bad = await TOOL_INDEX.board_create.impl.run({ title: "Nope", assignee: "does-not-exist" }, ctx);
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /unknown assignee "does-not-exist"/);
  const { card } = await board.create({ title: "Real", assignee: "alpha-agent" });
  const blocked = await TOOL_INDEX.board_create.impl.run(
    { title: "Waits on nothing", assignee: "alpha-agent", blocked_by: ["crd_ghost"] },
    ctx,
  );
  assert.equal(blocked.is_error, true);
  assert.match(blocked.content, /crd_ghost/);
  const ok = await TOOL_INDEX.board_create.impl.run(
    { title: "Real work", assignee: "beta-agent", body: "do it", blocked_by: [card.id] },
    ctx,
  );
  assert.equal(ok.is_error, undefined);
  const made = JSON.parse(ok.content);
  assert.equal(made.created, true);
  assert.equal(made.assignee, "beta-agent");
  assert.equal(made.status, "blocked"); // waits on Real
});

test("R1: a card blocked after a failed run stays blocked — later passes do not re-run it", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([
    ["alpha-agent", await loadAgent("alpha-agent", FIX)],
    ["beta-agent", await loadAgent("beta-agent", FIX)],
  ]);
  let betaRuns = 0;
  const provider = (specName: string) => {
    // alpha succeeds; beta's scripted provider has no replies, so its run errors out
    if (specName === "beta-agent") betaRuns++;
    return specName === "alpha-agent" ? scripted() : new FakeProvider([]);
  };
  const d = new Dispatcher({ board, specs, provider: (s) => provider(s.name), runsDir });
  const a = await board.create({ title: "Upstream", assignee: "alpha-agent" });
  const b = await board.create({ title: "Downstream fails", assignee: "beta-agent", blocked_by: [a.card.id] });
  await d.pass();
  await d.wait(); // A done
  await d.pass();
  await d.wait(); // B ran and failed -> blocked
  assert.equal((await board.get(b.card.id)).status, "blocked");
  const again = await d.pass(); // the failure must stick: no heal-reopen, no second run
  assert.equal(again.started, 0);
  assert.ok(again.skipped.length === 0);
  assert.equal(betaRuns, 1); // beta ran exactly once
  assert.equal((await board.get(b.card.id)).status, "blocked");
});

test("R2: the studio lock refuses a second holder while the first is alive", async () => {
  const runsDir = tmpDir();
  const first = acquireStudioLock(runsDir);
  assert.throws(() => acquireStudioLock(runsDir), /another studio loop/);
  first.release();
  const second = acquireStudioLock(runsDir); // released -> takeable again
  second.release();
  // a stale lock (dead pid) is taken over
  writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999999, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const third = acquireStudioLock(runsDir);
  third.release();
});

test("R2: requeue skips a doing card whose claiming process is still alive, and one a finished run could not close", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([["alpha-agent", await loadAgent("alpha-agent", FIX)]]);
  const live = await board.create({ title: "Held live", assignee: "alpha-agent" });
  await board.update(live.card.id, { status: "doing", claim: { pid: process.pid, host: hostname(), run_id: "r-live" } });
  const dead = await board.create({ title: "Dead holder", assignee: "beta-agent" });
  await board.update(dead.card.id, { status: "doing", claim: { pid: 99999999, host: hostname(), run_id: "r-dead" } });
  const unclosed = await board.create({ title: "Close failed" });
  await board.update(unclosed.card.id, { status: "doing", claim: { pid: 99999999, host: hostname(), run_id: "r-x" } });
  await board.comment(unclosed.card.id, "dispatcher: close failed after run r-x (status done): board down — run finished; not requeuing", "dispatcher");
  const d = new Dispatcher({ board, specs, provider: () => scripted(), runsDir });
  const requeued = await d.requeueOrphans();
  assert.equal(requeued, 1); // only the dead-holder card
  assert.equal((await board.get(live.card.id)).status, "doing");
  assert.equal((await board.get(unclosed.card.id)).status, "doing");
  assert.equal((await board.get(dead.card.id)).status, "todo");
});

test("R3: a failed close is retried, then marked so requeue never re-runs the finished run", async () => {
  const runsDir = tmpDir();
  const real = new LocalBoard(path.join(runsDir, "board.jsonl"));
  let closes = 0;
  const flaky: Board = {
    create: (c) => real.create(c),
    get: (id) => real.get(id),
    list: () => real.list(),
    update: (id, patch) => {
      if (patch.status === "done") { closes++; throw new Error("board is down"); }
      return real.update(id, patch);
    },
    comment: (id, body, author) => real.comment(id, body, author),
    comments: (id) => real.comments(id),
  };
  const specs = new Map([["alpha-agent", await loadAgent("alpha-agent", FIX)]]);
  const logs: string[] = [];
  const d = new Dispatcher({ board: flaky, specs, provider: () => scripted(), runsDir, log: (l) => logs.push(l) });
  const { card } = await flaky.create({ title: "Runs fine, closes badly", assignee: "alpha-agent" });
  await d.pass();
  await d.wait();
  assert.ok(closes >= 3); // retried, not swallowed
  assert.ok(logs.some((l) => /could not close/.test(l)));
  const comments = await real.comments(card.id);
  assert.ok(comments.some((c) => c.body.startsWith("dispatcher: close failed after run")));
  // and the marker holds: a restart does not requeue the card into a second run
  const d2 = new Dispatcher({ board: real, specs, provider: () => scripted(), runsDir });
  assert.equal(await d2.requeueOrphans(), 0);
  assert.equal((await real.get(card.id)).status, "doing");
});

test("R5: the dispatcher claims with a comment, not a note", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([["alpha-agent", await loadAgent("alpha-agent", FIX)]]);
  const gate = Promise.withResolvers<void>();
  const parked: Provider = {
    label: "parked",
    async complete(): Promise<ModelReply> {
      await gate.promise;
      return { content: [{ type: "tool_use", id: "p1", name: "submit_result", input: { answer: "ok" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, cost_micro_usd: 0, request_id: "p1", model: "parked" };
    },
  };
  const d = new Dispatcher({ board, specs, provider: () => parked, runsDir });
  const { card } = await board.create({ title: "Claimed cleanly", assignee: "alpha-agent" });
  await d.pass();
  assert.equal(d.busy, 1); // run in flight: claimed, nothing written back yet
  const seen = await board.get(card.id);
  assert.equal(seen.status, "doing");
  assert.equal(seen.note, null); // the claim is not a note — done will still need a real one
  assert.ok((await board.comments(card.id)).some((c) => /^dispatcher: claimed for local run /.test(c.body)));
  gate.resolve();
  await d.wait();
  assert.equal((await board.get(card.id)).status, "done");
  assert.match((await board.get(card.id)).note!, /^done: run /);
});
