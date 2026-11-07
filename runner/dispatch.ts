// The studio dispatcher (T4): polls the board and runs local agents on due cards — the local
// twin of Naïve's board clock. Same rules the hosted clock applies, so the board reads the same
// on both backends: one doing card per assignee, blocked cards wait, done needs a note.
// scripts/studio-loop.ts is the CLI (`npm run studio`); the logic lives here so tests drive it.
import { RUNS_DIR, runAgent, denyAll, type Approver, type RunResult } from "./run.ts";
import { killSwitchOn } from "./spend.ts";
import type { AgentSpec } from "./spec.ts";
import type { Provider } from "./types.ts";
import type { NaiveClient } from "./providers.ts";
import type { Board, BoardCard } from "./board/index.ts";

export interface DispatchOptions {
  board: Board;
  /** Dispatchable agents by spec name (runner: local). A card assigned anything else is left
   *  alone: hosted agents are the Naïve clock's to start, never ours. */
  specs: Map<string, AgentSpec>;
  provider: (spec: AgentSpec) => Provider;
  naive?: NaiveClient | null;
  /** PLUG-IN POINT — durable approval queue (another seat): pass an Approver that records
   *  ask-requests durably and resolves them. Default denies every ask (run.ts denyAll), so a
   *  gated tool simply fails until the real queue is wired here. */
  approver?: Approver;
  maxParallel?: number; // in-flight runs across all agents; default 2
  runsDir?: string; // where runs/ lives (and where the KILL file is checked); default <repo>/runs
  log?: (line: string) => void;
  /** PLUG-IN POINT — run resume (T5): called for each `doing` card found at startup with no
   *  live run. Return true if the resume path owns the card (it stays doing); return false and
   *  the card is requeued to todo with a comment saying why. */
  onResumeOrphan?: (card: BoardCard) => Promise<boolean>;
}

export interface PassResult {
  started: number;
  skipped: string[]; // card ids left for a later pass, with the reason
  killed: boolean;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The task handed to an agent: the card, plus what its finished blockers produced. */
export function cardTask(card: BoardCard, blockers: BoardCard[]): string {
  const parts = [`# ${card.title}`, card.body].filter(Boolean);
  if (blockers.length) {
    parts.push(
      "--- Upstream results (done cards this card waited on) ---\n" +
        blockers.map((b) => `## ${b.title} (${b.id})\n${b.note ?? "(no note)"}`).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

function summary(r: RunResult): string {
  if (r.output === null || r.output === undefined) return "(no output)";
  const text = typeof r.output === "string" ? r.output : JSON.stringify(r.output);
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

export class Dispatcher {
  private inflight = new Map<string, Promise<void>>(); // agent name → its run's completion
  constructor(readonly opts: DispatchOptions) {}

  get busy(): number {
    return this.inflight.size;
  }

  /** Await every in-flight run (they close their own cards). */
  async wait(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** Restart safety: a `doing` card with no live run (found at startup, before any dispatch)
   *  goes back to todo — unless the T5 resume hook (onResumeOrphan) claims it. */
  async requeueOrphans(): Promise<number> {
    let requeued = 0;
    for (const card of await this.opts.board.list()) {
      if (card.status !== "doing") continue;
      if (this.opts.onResumeOrphan && (await this.opts.onResumeOrphan(card))) continue;
      await this.opts.board.update(card.id, { status: "todo" });
      await this.opts.board.comment(card.id, "dispatcher: requeued to todo — restarted with no live run for this card", "dispatcher");
      this.opts.log?.(`requeued orphaned doing card ${card.id} (${card.assignee ?? "unassigned"})`);
      requeued++;
    }
    return requeued;
  }

  /** One pass: start every due card that fits under max-parallel. Never waits for runs. */
  async pass(): Promise<PassResult> {
    const runsDir = this.opts.runsDir ?? RUNS_DIR;
    if (killSwitchOn(runsDir)) return { started: 0, skipped: [], killed: true };
    const board = this.opts.board;
    const cards = await board.list();
    const byId = new Map(cards.map((c) => [c.id, c]));
    const holders = new Set(cards.filter((c) => c.status === "doing").map((c) => c.assignee));
    const maxParallel = this.opts.maxParallel ?? 2;
    const skipped: string[] = [];
    let started = 0;
    for (const card of cards) {
      if (this.busy >= maxParallel) break;
      if (card.status !== "todo") continue;
      if (this.inflight.has(card.assignee ?? "") || holders.has(card.assignee)) {
        skipped.push(`${card.id}: ${card.assignee} already holds a doing card`);
        continue;
      }
      if (!card.assignee || !this.opts.specs.has(card.assignee)) {
        skipped.push(`${card.id}: assignee ${card.assignee ?? "(none)"} is not a local agent spec`);
        continue;
      }
      const open = card.blocked_by.filter((id) => byId.get(id)?.status !== "done");
      if (open.length) {
        skipped.push(`${card.id}: waits on ${open.join(", ")}`);
        continue;
      }
      await this.start(card);
      started++;
    }
    return { started, skipped, killed: false };
  }

  /** Claim a card and run its assignee; closes the card when the run settles. */
  private async start(card: BoardCard): Promise<void> {
    const spec = this.opts.specs.get(card.assignee!)!;
    const board = this.opts.board;
    await board.update(card.id, { status: "doing", note: `dispatcher: claimed for a local run (${spec.name})` });
    const blockers = await Promise.all(card.blocked_by.map((id) => board.get(id)));
    const task = cardTask(card, blockers);
    this.opts.log?.(`▶ ${spec.name} on card ${card.id}: ${card.title}`);
    const done = this.run(spec, card, task);
    this.inflight.set(spec.name, done);
    done.finally(() => this.inflight.delete(spec.name)).catch(() => {});
  }

  private async run(spec: AgentSpec, card: BoardCard, task: string): Promise<void> {
    const board = this.opts.board;
    const runsDir = this.opts.runsDir ?? RUNS_DIR;
    let r: RunResult;
    try {
      r = await runAgent(spec, {
        task,
        provider: this.opts.provider(spec),
        naive: this.opts.naive ?? null,
        approver: this.opts.approver ?? denyAll,
        runsDir,
        board, // so board_* tools work inside dispatched runs (real hand-offs)
        log: (l) => this.opts.log?.(`  ${l}`),
      });
    } catch (e) {
      await board.update(card.id, { status: "blocked", note: `dispatcher error: ${errText(e)}` });
      this.opts.log?.(`✗ card ${card.id} blocked: ${errText(e)}`);
      return;
    }
    const money = `$${(r.spent_micro_usd / 1e6).toFixed(4)}`;
    if (r.status === "done") {
      await board.update(card.id, { status: "done", note: `done: run ${r.run_id}, ${money} — ${summary(r)}` });
      this.opts.log?.(`✓ card ${card.id} done: run ${r.run_id}, ${money}`);
    } else if (r.status === "killed") {
      // The kill switch stops spend, not the work: requeue so the loop picks the card up
      // again once runs/KILL is gone. (Any other failure blocks the card with the error.)
      await board.update(card.id, { status: "todo" });
      await board.comment(card.id, `dispatcher: requeued — run ${r.run_id} was killed by the kill switch`, "dispatcher");
      this.opts.log?.(`■ card ${card.id} requeued: run ${r.run_id} killed`);
    } else {
      await board.update(card.id, { status: "blocked", note: `${r.status}: run ${r.run_id}, ${money} — ${r.error ?? "(no error text)"}` });
      this.opts.log?.(`✗ card ${card.id} blocked: run ${r.run_id} ended ${r.status}`);
    }
  }
}

/** The studio loop: requeue orphans, then pass/sleep until killed or (with once) after one pass. */
export async function studioLoop(
  opts: DispatchOptions & { pollS?: number; once?: boolean },
): Promise<void> {
  const d = new Dispatcher(opts);
  const log = opts.log ?? (() => {});
  const requeued = await d.requeueOrphans();
  if (requeued) log(`startup: requeued ${requeued} orphaned card(s)`);
  for (;;) {
    const res = await d.pass();
    if (res.killed) {
      log("kill switch on: not dispatching; waiting for in-flight runs, then exiting");
      break;
    }
    if (opts.once) break;
    const { promise: tick, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, Math.max(1, opts.pollS ?? 10) * 1000);
    await tick;

  }
  await d.wait(); // both --once and a kill let started runs finish and close their cards
  log("dispatcher exit");
}
