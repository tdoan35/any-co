import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider } from "./providers.ts";
import { Dispatcher, studioLoop, type HeadCycle } from "./dispatch.ts";
import { LocalBoard } from "./board/local.ts";
import type { ModelReply, Provider, ToolUseBlock } from "./types.ts";
import { decide, pending, queueApprover } from "../tools/approvals/approvals.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH = path.join(HERE, "__fixtures__", "dispatch-agents");
const AGENTS = path.join(HERE, "__fixtures__", "agents");
const tmpDir = () => mkdtempSync(path.join(tmpdir(), "anyco-loop-"));
const submit = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "submit_result", input: { answer: "ok" } });
const reply = (content: ModelReply["content"]): ModelReply => ({ content, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, cost_micro_usd: 0, request_id: "r", model: "fake" });

/** A head cycle whose turns are counted; with `gate`, every turn parks until the gate opens. */
async function countingHead(gate?: Promise<void>) {
  const spec = await loadAgent("alpha-agent", DISPATCH);
  const turns = { started: 0, inFlight: 0, maxInFlight: 0 };
  const head: HeadCycle = {
    spec,
    task: "cycle",
    provider: (): Provider => ({
      label: "head",
      async complete() {
        turns.started++;
        turns.inFlight++;
        turns.maxInFlight = Math.max(turns.maxInFlight, turns.inFlight);
        if (gate) await gate;
        turns.inFlight--;
        return reply([submit(`h${turns.started}`)]);
      },
    }),
  };
  return { head, turns };
}

test("head cycle: one turn per cadence tick on a fake clock, none before it is due", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const { head, turns } = await countingHead();
  let clock = 0;
  let ticks = 0;
  await studioLoop({
    board, specs: new Map(), provider: () => new FakeProvider([]), runsDir,
    head, headEveryMin: 120,
    now: () => clock,
    // each poll advances the clock 30 min: due at ticks 4 and 8 (120, 240 min)
    sleep: async () => { clock += 30 * 60_000; ticks++; await new Promise((r) => setImmediate(r)); },
    shouldStop: () => ticks >= 9,
  });
  assert.equal(turns.started, 2);
  assert.equal(existsSync(path.join(runsDir, "studio.lock")), false); // released on exit
});

test("head cycle: single-flight — a slow turn is never doubled by later ticks", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const gate = Promise.withResolvers<void>();
  const { head, turns } = await countingHead(gate.promise);
  let clock = 0;
  let ticks = 0;
  await studioLoop({
    board, specs: new Map(), provider: () => new FakeProvider([]), runsDir,
    head, headEveryMin: 1,
    now: () => clock,
    sleep: async () => {
      clock += 5 * 60_000; // every tick is past due
      ticks++;
      await new Promise((r) => setImmediate(r));
      if (ticks === 6) gate.resolve(); // the first turn finishes only after many due ticks
    },
    shouldStop: () => ticks >= 6,
  });
  assert.equal(turns.maxInFlight, 1);
  assert.equal(turns.started, 1);
});

test("head cycle: auto-start at loop start when the board is empty and a Greenlight pick exists", async () => {
  for (const [pick, cards, expected] of [[true, 0, 1], [false, 0, 0], [true, 1, 0]] as const) {
    const runsDir = tmpDir();
    const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
    if (cards) await board.create({ title: "already planned" });
    const { head, turns } = await countingHead();
    await studioLoop({
      board, specs: new Map(), provider: () => new FakeProvider([]), runsDir,
      head, headEveryMin: 120, once: true,
      now: () => 0, hasGreenlightPick: () => pick,
    });
    assert.equal(turns.started, expected, `pick=${pick} cards=${cards}`);
  }
});

test("head cycle stays off without --head-every-min, even with a pick on an empty board", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const { head, turns } = await countingHead();
  await studioLoop({ board, specs: new Map(), provider: () => new FakeProvider([]), runsDir, head, once: true, hasGreenlightPick: () => true });
  assert.equal(turns.started, 0);
});

/** good-agent: workspace_write is `ask`. The run asks once, then submits. */
async function gatedRun(decision: "approve" | "deny") {
  const runsDir = tmpDir();
  const approvals = path.join(runsDir, "approvals.jsonl");
  const ledger = path.join(runsDir, "ledger.jsonl");
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const specs = new Map([["good-agent", await loadAgent("good-agent", AGENTS)]]);
  const write: ToolUseBlock = { type: "tool_use", id: "w1", name: "workspace_write", input: { path: "out.txt", content: "hello" } };
  const d = new Dispatcher({
    board, specs, runsDir,
    provider: () => new FakeProvider([{ content: [write] }, { content: [submit("s1")] }]),
    approver: queueApprover({ timeoutMs: 30_000, pollMs: 10, file: approvals, ledgerFile: ledger }),
  });
  const { card } = await board.create({ title: "Write a file", assignee: "good-agent" });
  await d.pass();
  // the run is parked on the approval: the card is doing and one request is pending. The queue is
  // file-backed and the approver polls it on a real timer (T1), so there is no event to await —
  // wait on the condition, bounded.
  let req = pending(approvals);
  for (let i = 0; i < 200 && !req.length; i++) { await new Promise((r) => setTimeout(r, 10)); req = pending(approvals); }
  assert.equal(req.length, 1);
  assert.equal(req[0].tool, "workspace_write");
  assert.equal((await board.get(card.id)).status, "doing");
  assert.equal(d.busy, 1);
  decide(req[0].id, decision === "approve", "operator", decision === "deny" ? "not now" : undefined, approvals, ledger);
  await d.wait();
  const runDir = path.join(runsDir, (await board.comments(card.id)).find((c) => c.body.startsWith("dispatcher: claimed"))!.body.split(" ").at(-1)!);
  return { status: (await board.get(card.id)).status, wrote: existsSync(path.join(runDir, "workspace", "out.txt")) };
}

test("approvals: a dispatched run waits on the queue and proceeds on approve", async () => {
  const r = await gatedRun("approve");
  assert.equal(r.status, "done");
  assert.equal(r.wrote, true);
});

test("approvals: on deny the gated tool never runs", async () => {
  const r = await gatedRun("deny");
  assert.equal(r.wrote, false);
  assert.equal(r.status, "done"); // the model was told no and submitted without the file
});
