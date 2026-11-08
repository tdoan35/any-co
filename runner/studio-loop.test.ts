import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, loadAllAgents } from "./load.ts";
import { HEAD_TASK } from "./head-cycle.ts";
import { IMPLS } from "./tools/impl.ts";
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

test("head cycle: --head-now runs one turn at startup even on a busy board; the kill switch blocks head turns", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  await board.create({ title: "already planned" });
  const { head, turns } = await countingHead();
  await studioLoop({ board, specs: new Map(), provider: () => new FakeProvider([]), runsDir, head, headEveryMin: 120, once: true, now: () => 0, headNow: true });
  assert.equal(turns.started, 1);

  const killed = tmpDir();
  writeFileSync(path.join(killed, "KILL"), "");
  const k = await countingHead();
  await studioLoop({ board: new LocalBoard(path.join(killed, "board.jsonl")), specs: new Map(), provider: () => new FakeProvider([]), runsDir: killed, head: k.head, headEveryMin: 120, once: true, now: () => 0, headNow: true, hasGreenlightPick: () => true });
  assert.equal(k.turns.started, 0);
});

test("end to end with the real agent specs: the Studio Head cycle assigns a card by a real agent name, and the loop dispatches it", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const { ok } = await loadAllAgents(); // the real agents/ folder
  const specs = new Map(ok.filter((s) => s.runner === "local").map((s) => [s.name, s]));
  const headSpec = specs.get("studio-head")!;
  assert.ok(headSpec && specs.has("market-analyst"));
  const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
  // the head looks, assigns one card, logs the decision, and stops (a scripted model; no inference)
  const headProvider = new FakeProvider([
    { content: [use("a", "board_list", {}), use("b", "studio_agents", {})], stop_reason: "tool_use" },
    { content: [use("c", "board_create", { title: "Dry-run card for the loop", body: "Harness dry run: no real work.", assignee: "market-analyst", key: "assign-market-analyst-dry-run" })], stop_reason: "tool_use" },
    { content: [use("d", "log_decision", { topic: "studio.cycle", decision: "Assigned the dry-run card", rationale: "End-to-end harness check of the head cycle." })], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Assigned one card." }] },
  ]);
  let dispatchedAgent: string | null = null;
  let ticks = 0;
  await studioLoop({
    board, specs, runsDir,
    provider: (spec) => { dispatchedAgent = spec.name; return new FakeProvider([{ content: [{ type: "text", text: "(dry run)" }] }]); },
    head: { spec: headSpec, task: HEAD_TASK, provider: () => headProvider },
    headEveryMin: 120, headNow: true,
    now: () => 0,
    sleep: async () => { ticks++; await new Promise((r) => setTimeout(r, 20)); },
    shouldStop: () => dispatchedAgent !== null || ticks > 100,
  });
  const cards = await board.list();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].assignee, "market-analyst");
  assert.equal(dispatchedAgent, "market-analyst", "the dispatcher started the assignee's run");
  assert.notEqual(cards[0].status, "todo");
  const comments = await board.comments(cards[0].id);
  assert.ok(comments.some((c) => c.body.startsWith("dispatcher: claimed")));
  // the head's decision lands in this runs dir's ledger, not the repo's
  const ledger = readFileSync(path.join(runsDir, "ledger.jsonl"), "utf8");
  assert.match(ledger, /"topic":"studio.cycle"/);
  assert.ok(headProvider.requests[0].messages.some((m) => JSON.stringify(m.content).includes("Studio cycle.")));
  // a made-up assignee is refused with the real roster in the error
  const bad = await IMPLS.board.board_create.run({ title: "Nobody", assignee: "game-designer-9000" }, { workspace: runsDir, naive: null, board });
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /known agents: .*market-analyst/);
});

// ----- T47: an early studio-head cycle when a card closes and the board goes idle -----

/** A run that closes its card done at once (fake provider submits immediately). */
function closingProvider(counter: { n: number }): Provider {
  return {
    label: "closer",
    async complete() {
      counter.n++;
      return reply([submit(`done-${counter.n}`)]);
    },
  };
}

async function withEnvT47<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}

const headEarlyEntries = (runsDir: string): number => {
  const f = path.join(runsDir, "ledger.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").split("\n").filter(Boolean).filter((l) => l.includes('"studio.head_early"')).length;
};

test("T47: a close on an idle board triggers exactly one early head cycle (ledger + log)", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  await board.create({ title: "only card", assignee: "alpha-agent" });
  const { head, turns } = await countingHead();
  const closes = { n: 0 };
  const logs: string[] = [];
  let clock = 0;
  let polls = 0;
  await withEnvT47({ STUDIO_HEAD_EARLY_MIN: "3" }, async () => {
    await studioLoop({
      board,
      specs: new Map([["alpha-agent", await loadAgent("alpha-agent", DISPATCH)]]),
      provider: () => closingProvider(closes),
      log: (l: string) => logs.push(l),
      runsDir,
      head, headEveryMin: 10_000, // backstop far away: any cycle in this test is early
      now: () => clock,
      sleep: async () => {
        clock += 1000; // 1 s polls: inside the 3-min debounce window
        polls++;
        await new Promise((r) => setImmediate(r));
      },
      shouldStop: () => polls >= 40 || (closes.n >= 1 && turns.started >= 1 && headEarlyEntries(runsDir) >= 1 && polls >= 6),
    });
  });
  assert.equal(closes.n, 1, "the single card ran and closed");
  assert.equal(turns.started, 1, `exactly one early cycle; logs: ${logs.join(" | ").slice(0, 300)}`);
  assert.equal(headEarlyEntries(runsDir), 1, "one studio.head_early ledger decision");
  assert.ok(logs.some((l) => l.includes("head: early cycle")), `log line present: ${logs.join(" | ").slice(0, 200)}`);
});

test("T47: a close while another todo card can start triggers NO early cycle", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  const { head, turns } = await countingHead();
  const closes = { n: 0 };
  let clock = 0;
  let polls = 0;
  // two cards for one agent, maxParallel 1: while A runs, B is todo+startable; A's close leaves
  // work for the next pass, so the board is NOT idle and the early cycle must not fire. B then
  // runs and closes with nothing left -> exactly one early cycle, from B's close.
  await board.create({ title: "a", assignee: "alpha-agent" });
  await board.create({ title: "b", assignee: "alpha-agent" });
  await withEnvT47({ STUDIO_HEAD_EARLY_MIN: "3" }, async () => {
    await studioLoop({
      board,
      specs: new Map([["alpha-agent", await loadAgent("alpha-agent", DISPATCH)]]),
      provider: () => closingProvider(closes),
      maxParallel: 1,
      runsDir,
      head, headEveryMin: 10_000,
      now: () => clock,
      sleep: async () => {
        clock += 1000;
        polls++;
        await new Promise((r) => setImmediate(r));
      },
      shouldStop: () => closes.n >= 2 && polls >= 8,
    });
  });
  assert.equal(closes.n, 2);
  assert.equal(turns.started, 1, "only the final idle close cycles; the mid-board close does not");
  assert.equal(headEarlyEntries(runsDir), 1);
});

test("T47: STUDIO_HEAD_EARLY_MIN=0 disables the early cycle; the timed backstop still fires", async () => {
  const runsDir = tmpDir();
  const board = new LocalBoard(path.join(runsDir, "board.jsonl"));
  await board.create({ title: "only card", assignee: "alpha-agent" });
  const { head, turns } = await countingHead();
  const closes = { n: 0 };
  const logs: string[] = [];
  let clock = 0;
  let polls = 0;
  await withEnvT47({ STUDIO_HEAD_EARLY_MIN: "0" }, async () => {
    await studioLoop({
      board,
      specs: new Map([["alpha-agent", await loadAgent("alpha-agent", DISPATCH)]]),
      provider: () => closingProvider(closes),
      log: (l: string) => logs.push(l),
      runsDir,
      head, headEveryMin: 1, // backstop: 1 min of fake clock
      now: () => clock,
      sleep: async () => {
        clock += 20_000; // 20 s polls: the backstop is due on the 4th tick (80 s)
        polls++;
        await new Promise((r) => setImmediate(r));
      },
      shouldStop: () => polls >= 6 && turns.started >= 1,
    });
  });
  assert.equal(closes.n, 1, "the card ran and closed (would be idle: the early path is what is disabled)");
  assert.equal(headEarlyEntries(runsDir), 0, "no studio.head_early decision when disabled");
  assert.equal(turns.started, 1, "the timed backstop fired once");
  assert.equal(logs.some((l) => l.includes("head: early cycle")), false, "no early-cycle log line");
});
