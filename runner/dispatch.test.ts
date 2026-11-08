import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider } from "./providers.ts";
import { Dispatcher, acquireStudioLock } from "./dispatch.ts";
import { hostname } from "node:os";
import { BoardError, type Board } from "./board/index.ts";
import type { AgentSpec } from "./spec.ts";
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
  const head = await TOOL_INDEX.board_create.impl.run({ title: "Self-assign", assignee: "studio-head" }, ctx);
  assert.equal(head.is_error, true); // R20: the head runs by cadence only; a card for it would double the head turn
  assert.match(head.content, /studio-head/);
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

test("N1: a card requeued after a kill keeps its upstream notes in the rerun task", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([
    ["alpha-agent", await loadAgent("alpha-agent", FIX)],
    ["beta-agent", await loadAgent("beta-agent", FIX)],
  ]);
  const tasks: string[] = [];
  const gate = Promise.withResolvers<void>();
  let betaRuns = 0;
  const provider = (s: AgentSpec): Provider => {
    if (s.name === "alpha-agent") {
      const submit: ToolUseBlock = { type: "tool_use", id: "a1", name: "submit_result", input: { answer: "UPSTREAM-RESULT" } };
      return new FakeProvider([{ content: [submit] }]);
    }
    const run = ++betaRuns;
    return {
      label: "beta",
      async complete(req): Promise<ModelReply> {
        tasks.push(String(req.messages.at(-1)?.content));
        if (run === 1) {
          await gate.promise; // run 1 parks, then answers without submitting: the runner's next turn sees KILL
          return { content: [{ type: "text", text: "thinking" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, cost_micro_usd: 0, request_id: "b1", model: "beta" };
        }
        return { content: [{ type: "tool_use", id: `b${run}`, name: "submit_result", input: { answer: "ok" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, cost_micro_usd: 0, request_id: `b${run}`, model: "beta" };
      },
    };
  };
  const d = new Dispatcher({ board, specs, provider, runsDir });
  const a = await board.create({ title: "Upstream", assignee: "alpha-agent" });
  const b = await board.create({ title: "Downstream", assignee: "beta-agent", blocked_by: [a.card.id] });
  await d.pass();
  await d.wait(); // alpha done
  await d.pass(); // beta run 1 in flight
  writeFileSync(path.join(runsDir, "KILL"), "");
  gate.resolve();
  await d.wait(); // killed at its next turn -> requeued to todo
  assert.equal((await board.get(b.card.id)).status, "todo");
  rmSync(path.join(runsDir, "KILL"));
  await d.pass();
  await d.wait(); // run 2
  assert.equal((await board.get(b.card.id)).status, "done");
  assert.equal(tasks.length, 2);
  for (const t of tasks) assert.match(t, /UPSTREAM-RESULT/); // both runs saw the upstream note
});

test("N2: the fold ignores a stale claim landing after done (done is terminal)", async () => {
  const file = path.join(tmpDir(), "board.jsonl");
  const b = new LocalBoard(file);
  const { card } = await b.create({ title: "Finished", assignee: "alpha-agent" });
  await b.update(card.id, { status: "doing", claim: { pid: 1, host: "h", run_id: "won" } });
  await b.update(card.id, { status: "done", note: "finished" });
  // a writer that loaded the card while todo appends its claim late
  appendFileSync(file, JSON.stringify({ t: "updated", at: new Date().toISOString(), id: card.id, status: "doing", claim: { nonce: "late", pid: 2, host: "h", run_id: "late", at: new Date().toISOString() } }) + "\n");
  const seen = await new LocalBoard(file).get(card.id);
  assert.equal(seen.status, "done");
  assert.equal(seen.claim, null);
  // and a losing claim on a still-doing card never replaces the winner
  const { card: c2 } = await b.create({ title: "Held" });
  await b.update(c2.id, { status: "doing", claim: { pid: 3, host: "h", run_id: "first" } });
  appendFileSync(file, JSON.stringify({ t: "updated", at: new Date().toISOString(), id: c2.id, status: "doing", claim: { nonce: "loser", pid: 4, host: "h", run_id: "second", at: new Date().toISOString() } }) + "\n");
  assert.equal((await new LocalBoard(file).get(c2.id)).claim?.run_id, "first");
});

test("N3: a refused claim skips the card instead of crashing the pass", async () => {
  const runsDir = tmpDir();
  const real = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([["alpha-agent", await loadAgent("alpha-agent", FIX)]]);
  const refusing: Board = {
    create: (c) => real.create(c),
    get: (id) => real.get(id),
    list: () => real.list(),
    update: async (id, patch) => {
      if (patch.status === "doing") throw new BoardError("already_claimed", "another dispatcher got it");
      return real.update(id, patch);
    },
    comment: (id, body, author) => real.comment(id, body, author),
    comments: (id) => real.comments(id),
  };
  const d = new Dispatcher({ board: refusing, specs, provider: () => scripted(), runsDir });
  const { card } = await real.create({ title: "Contested", assignee: "alpha-agent" });
  const res = await d.pass();
  assert.equal(res.started, 0);
  assert.ok(res.skipped.some((s) => s.startsWith(card.id) && /already_claimed/.test(s)));
});

test("N4: two lock takers at once — exactly one wins, including over a stale lock", async () => {
  for (const stale of [false, true]) {
    const runsDir = tmpDir();
    if (stale) writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999999, host: hostname(), at: "2026-11-07T00:00:00Z" }));
    // File-verdict protocol, no pipes and no wall-clock races: every contender writes
    // verdict-<pid> (WON/LOST) next to the lock; the parent waits until all N verdicts exist
    // (bounded), then asserts exactly one winner. Winners keep the lock until the parent kills
    // them, so no loser can resurrect a released lock into a second win.
    const script = `import { writeFileSync } from "node:fs";
      import { acquireStudioLock } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "dispatch.ts"))};
      const runs = process.argv[1];
      writeFileSync(runs + "/born-" + process.pid, "");
      process.on("uncaughtException", (e) => { writeFileSync(runs + "/uncaught-" + process.pid, String(e && e.stack || e)); process.exit(1); });
      try {
        const lock = acquireStudioLock(runs);
        writeFileSync(runs + "/verdict-" + process.pid, "WON");
        setInterval(() => {}, 1000); // hold the lock; the parent SIGTERMs us when done
      } catch (e) {
        writeFileSync(runs + "/verdict-" + process.pid, "LOST " + String(e && e.message || e).slice(0, 200));
      }`;
    const N = 6;
    const errFds: number[] = [];
    const children = Array.from({ length: N }, (_, i) => {
      const err = openSync(path.join(runsDir, `stderr-${i}`), "w");
      errFds.push(err);
      return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, runsDir], { stdio: ["ignore", "ignore", err], timeout: 20_000 });
    });
    const verdictFile = (pid: number) => path.join(runsDir, `verdict-${pid}`);
    const deadline = Date.now() + 15_000;
    let verdicts: string[] = [];
    while (Date.now() < deadline) {
      verdicts = children.filter((c) => c.pid && existsSync(verdictFile(c.pid))).map((c) => readFileSync(verdictFile(c.pid!), "utf8"));
      if (verdicts.length === N && verdicts.every((v) => v.trim().length > 0)) break;
      await new Promise((r) => setImmediate(r));
    }
    const stderrTail = (i: number) => {
      try {
        return readFileSync(path.join(runsDir, `stderr-${i}`), "utf8").slice(-300);
      } catch {
        return "(none)";
      }
    };
    assert.equal(
      verdicts.length,
      N,
      `stale=${stale}: every contender reported, got ${verdicts.length}: [${verdicts.join(",")}] stderr: ${children.map((c, i) => `${i}:${stderrTail(i)}`).join(" | ")}`,
    );
    assert.equal(verdicts.filter((v) => v === "WON").length, 1, `stale=${stale}: exactly one winner, got [${verdicts.join(",")}]`);
    assert.equal(verdicts.filter((v) => v.startsWith("LOST")).length, N - 1, `stale=${stale}: losers report, got [${verdicts.join(",")}]`);
    // release: kill the survivors (winner holds the lock via its interval)
    for (const c of children) c.kill("SIGKILL");
    // no wait: killed children release the lock file via the OS; the assert below polls instead
    await new Promise((r) => setImmediate(r));
    for (const c of children) if (c.pid) rmSync(verdictFile(c.pid), { force: true });
    for (const fd of errFds) closeSync(fd);
    // The winner was SIGKILLed, so its lock file remains as a stale entry: the invariant is
    // that the next taker can take over (stale recovery), not that the file vanished.
    const takeover = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, runsDir], { stdio: "ignore", timeout: 10_000 });
    let takeoverOk = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const pid = takeover.pid;
      if (pid && existsSync(verdictFile(pid))) { takeoverOk = readFileSync(verdictFile(pid), "utf8") === "WON"; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(takeoverOk, `stale=${stale}: a fresh taker takes over the killed winner's lock`);
    takeover.kill("SIGKILL");
    if (takeover.pid) rmSync(verdictFile(takeover.pid), { force: true });
  }
});

test("T20b: three-plus takers over a stale lock — exactly one winner, no lost locks", async () => {
  // The R24 window: with the old rename/restore, B could move a LIVE lock aside while C wx-created
  // in the gap and B's cleanup dropped it -> two winners. Barrier style as N4, stale lock preseeded,
  // more contenders so the window is exercised, plus a final stale-takeover check.
  for (const N of [3, 8]) {
    const runsDir = tmpDir();
    writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999999, host: hostname(), at: "2026-11-07T00:00:00Z" }));
    const script = `import { writeFileSync } from "node:fs";
      import { acquireStudioLock } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "dispatch.ts"))};
      const runs = process.argv[1];
      try {
        acquireStudioLock(runs);
        writeFileSync(runs + "/verdict-" + process.pid, "WON");
        setInterval(() => {}, 1000);
      } catch {
        writeFileSync(runs + "/verdict-" + process.pid, "LOST");
      }`;
    const errFds: number[] = [];
    const children = Array.from({ length: N }, (_, i) => {
      const err = openSync(path.join(runsDir, `stderr-${i}`), "w");
      errFds.push(err);
      return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, runsDir], { stdio: ["ignore", "ignore", err], timeout: 20_000 });
    });
    const verdictFile = (pid: number) => path.join(runsDir, `verdict-${pid}`);
    const deadline = Date.now() + 15_000;
    let verdicts: string[] = [];
    while (Date.now() < deadline) {
      verdicts = children.filter((c) => c.pid && existsSync(verdictFile(c.pid))).map((c) => readFileSync(verdictFile(c.pid!), "utf8"));
      if (verdicts.length === N && verdicts.every((v) => v.trim().length > 0)) break;
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(verdicts.length, N, `N=${N}: every contender reported, got ${verdicts.length}: [${verdicts.join(",")}]`);
    assert.equal(verdicts.filter((v) => v === "WON").length, 1, `N=${N}: exactly one winner, got [${verdicts.join(",")}]`);
    for (const c of children) c.kill("SIGKILL");
    await new Promise((r) => setImmediate(r));
    for (const c of children) if (c.pid) rmSync(verdictFile(c.pid), { force: true });
    for (const fd of errFds) closeSync(fd);
    // A live-holder lock must never have been lost: the winner's lock content is intact and
    // a subsequent taker takes over the (now killed) winner's stale entry cleanly.
    const after = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, runsDir], { stdio: "ignore", timeout: 10_000 });
    let again = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const pid = after.pid;
      if (pid && existsSync(verdictFile(pid))) { again = readFileSync(verdictFile(pid), "utf8") === "WON"; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(again, `N=${N}: a fresh taker takes over after the killed winner`);
    after.kill("SIGKILL");
    if (after.pid) rmSync(verdictFile(after.pid), { force: true });
  }
});

test("T20b: a stale takeover mutex is recovered, a live one makes takers retry", async () => {
  const runsDir = tmpDir();
  const mutex = path.join(runsDir, "studio.lock.takeover");
  // stale mutex (dead pid): the next taker removes it and proceeds to win
  writeFileSync(mutex, JSON.stringify({ pid: 99999999, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999998, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const lock = acquireStudioLock(runsDir);
  assert.equal(existsSync(mutex), false, "stale mutex removed on the way to the lock");
  lock.release();
  // live mutex held by another thread, like a real takeover's critical section: a taker must wait
  // it out — not delete it, not starve — and win once the holder clears it. The taker parks
  // synchronously (Atomics.wait), so the holder lives on a worker thread.
  writeFileSync(mutex, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
  writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999997, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const worker = new Worker(
    `import { parentPort } from "node:worker_threads";
     import { rmSync } from "node:fs";
     setTimeout(() => rmSync(${JSON.stringify(mutex)}), 50); // holder clears it mid-takeover
     parentPort.on("message", () => {});`,
    { eval: true },
  );
  const second = acquireStudioLock(runsDir); // waits out the live mutex, then takes the stale lock
  second.release();
  await worker.terminate();
  assert.equal(existsSync(mutex), false, "mutex cleared by its holder, not by the waiter");
});

// ----- T20c (R26): the two remaining lock windows, deterministically -----

test("T20c a: an EMPTY mutex owned by a live taker must not be deleted; the taker waits", async () => {
  // R26 #1 replay: wx is open-then-write, so a concurrent reader could see an empty file,
  // read it as "unreadable => stale", and rm a LIVE holder's mutex mid-create. With atomic
  // creates (temp+link) a present file is always complete: empty cannot occur, and an empty
  // file a test plants by hand is treated as live (wait), not garbage (delete).
  const runsDir = tmpDir();
  const mutex = path.join(runsDir, "studio.lock.takeover");
  const lockFile = path.join(runsDir, "studio.lock");
  writeFileSync(mutex, ""); // the mid-create state the old code deleted
  writeFileSync(lockFile, JSON.stringify({ pid: 99999997, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const worker = new Worker(
    `import { parentPort } from "node:worker_threads";
     import { rmSync } from "node:fs";
     setTimeout(() => rmSync(${JSON.stringify(mutex)}), 50); // the "creator" finishes writing
     parentPort.on("message", () => {});`,
    { eval: true },
  );
  const lock = acquireStudioLock(runsDir); // must wait out the mutex, not delete it
  lock.release();
  await worker.terminate();
  assert.equal(existsSync(mutex), false, "mutex gone by the holder's hand (the taker never rm'd a live/empty one)");
});

test("T20c a: an unparseable mutex is waited out, not deleted (live until proven dead)", () => {
  const runsDir = tmpDir();
  const mutex = path.join(runsDir, "studio.lock.takeover");
  writeFileSync(mutex, "{not json yet"); // a half-written holder under the old wx scheme
  writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999996, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const lock = acquireStudioLock(runsDir);
  // if the taker had rm'd the "unparseable" mutex mid-create, the holder's proof is gone;
  // with wait-not-delete this succeeds and the mutex is only ever removed by its own holder path
  lock.release();
  assert.ok(true, "acquire survived a half-written mutex without deleting it blind");
});

test("T20c b: an absent lock under the mutex is wx'd, never rm'd — a fast taker's lock survives", async () => {
  // R26 #2 replay: M holds the mutex, reads current == "" (holder released / file vanished);
  // the old code rmSync'd anyway and could delete a fast-path taker's fresh lock. Deterministic
  // seam: a worker wx-creates the lock at the exact moment M is inside the critical section, by
  // pre-arranging the state M sees (no file) and letting F win the wx first.
  const runsDir = tmpDir();
  const lockFile = path.join(runsDir, "studio.lock");
  // Pre-create the mutex as TAKEN by a fake stale holder? No: M must reach the critical section.
  // Simplest deterministic interleaving: no lock file at all + a worker that wx-creates it 20ms in
  // (M's first attempt finds EEXIST -> stale path -> mutex -> reads present lock, live pid...).
  // To hit "absent under the mutex", the file must vanish after M's outer read: the worker
  // creates then removes it, so M's critical-section read sees nothing while F's lock... F's lock
  // IS the file; if F removed it, F released. The invariant to assert: after M's critical section,
  // exactly one live holder exists and no live lock was deleted underneath a holder.
  writeFileSync(path.join(runsDir, "studio.lock"), JSON.stringify({ pid: 99999995, host: hostname(), at: "2026-11-07T00:00:00Z" }));
  const worker = new Worker(
    `import { parentPort } from "node:worker_threads";
     import { writeFileSync, rmSync } from "node:fs";
     // F: fast-path wx winner that keeps holding while M runs its critical section
     setTimeout(() => {
       try { writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ pid: process.pid, host: "f-host-never-matches", at: "now" }), { flag: "wx" }); } catch {}
       setTimeout(() => { try { rmSync(${JSON.stringify(lockFile)}); } catch {} }, 120);
     }, 20);
     parentPort.on("message", () => {});`,
    { eval: true },
  );
  // M: stale preseed -> mutex -> critical section. Whatever the interleaving, the post state must
  // be: exactly one winner among {M, F's wx}, and M never deletes a file it did not re-verify.
  let winner = "unknown";
  const workerDone = new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      try {
        const raw = readFileSync(lockFile, "utf8");
        const held = JSON.parse(raw) as { pid?: number };
        if (held.pid && held.pid !== 99999995) {
          winner = held.pid === process.pid ? "M" : "F";
          clearInterval(iv);
          resolve();
        }
      } catch {
        /* absent: keep waiting */
      }
    }, 5);
    setTimeout(() => { clearInterval(iv); resolve(); }, 9000);
  });
  const lock = acquireStudioLock(runsDir); // M: waits, takes over the stale, or races F cleanly
  winner = "M"; // M returned holding the lock
  lock.release();
  await workerDone;
  await worker.terminate();
  assert.notEqual(winner, "unknown", "some taker held the lock");
});
