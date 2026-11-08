// The studio dispatcher (T4): polls the board and runs local agents on due cards — the local
// twin of Naïve's board clock. Same rules the hosted clock applies, so the board reads the same
// on both backends: one doing card per assignee, blocked cards wait, done needs a note.
// scripts/studio-loop.ts is the CLI (`npm run studio`); the logic lives here so tests drive it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { RUNS_DIR, stamp, runAgent, denyAll, type Approver, type RunResult } from "./run.ts";
import { killSwitchOn } from "./spend.ts";
import type { AgentSpec } from "./spec.ts";
import type { Provider } from "./types.ts";
import type { NaiveClient } from "./providers.ts";
import { BoardError, type Board, type BoardCard } from "./board/index.ts";

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

/** True when `pid` is a live process on this host (EPERM = alive but not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StudioLock {
  file: string;
  release: () => void;
}

/** Single-dispatcher lock (R2): runs/studio.lock records pid+host; a second loop refuses to
 *  start while the holder is alive, so two dispatchers can never run the same card. A lock
 *  whose holder is dead is taken over; an unreadable one is stale. */
export function acquireStudioLock(runsDir: string): StudioLock {
  mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, "studio.lock");
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() });
  // create-exclusive (N4): two loops started at the same instant cannot both pass a check-then-write
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      return { file, release: () => { try { rmSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let refusal: string | null = null;
    let staleText = "";
    try {
      staleText = readFileSync(file, "utf8");
      const held = JSON.parse(staleText) as { pid?: unknown; host?: unknown };
      const pid = typeof held.pid === "number" ? held.pid : NaN;
      const host = typeof held.host === "string" ? held.host : "";
      if (host && host !== hostname()) refusal = `pid ${pid} on ${host}`;
      else if (Number.isFinite(pid) && pidAlive(pid)) refusal = `pid ${pid} on this host`;
    } catch {
      /* unreadable or vanished lock: stale */
    }
    if (refusal) throw new Error(`another studio loop holds ${file} (${refusal}); refusing to start. If it is dead, remove the file.`);
    // stale: move it aside (rename is atomic — of two takers only one moves the stale file), and
    // check we moved the stale lock, not a fresh one another taker just wrote; then retry wx.
    const grave = `${file}.stale-${process.pid}-${attempt}`;
    try { renameSync(file, grave); } catch { continue; }
    let moved = "";
    try { moved = readFileSync(grave, "utf8"); } catch { /* gone */ }
    if (moved !== staleText) { try { renameSync(grave, file); } catch { /* best effort */ } continue; }
    try { rmSync(grave); } catch { /* already gone */ }
  }
  throw new Error(`could not take ${file}: another studio loop is starting at the same time`);
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

  /** Restart safety: a `doing` card goes back to todo only when nobody holds it — a live
   *  claiming process (claim.pid on this host) still runs it, and a card a finished run could
   *  not close carries a `dispatcher: close failed` comment that says do-not-requeue (R2/R3).
   *  The T5 resume hook (onResumeOrphan) can still claim any orphan first. */
  async requeueOrphans(): Promise<number> {
    let requeued = 0;
    for (const card of await this.opts.board.list()) {
      if (card.status !== "doing") continue;
      if (this.opts.onResumeOrphan && (await this.opts.onResumeOrphan(card))) continue;
      if (card.claim && card.claim.host === hostname() && pidAlive(card.claim.pid)) {
        this.opts.log?.(`card ${card.id}: held by live pid ${card.claim.pid} (run ${card.claim.run_id ?? "?"}); leaving it`);
        continue;
      }
      const comments = await this.opts.board.comments(card.id);
      if (comments.some((c) => c.body.startsWith("dispatcher: close failed after run"))) {
        this.opts.log?.(`card ${card.id}: a finished run could not close it; close it manually`);
        continue;
      }
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
      try {
        await this.start(card);
      } catch (e) {
        if (e instanceof BoardError && (e.code === "already_claimed" || e.code === "already_working")) {
          this.opts.log?.(`card ${card.id}: claim refused (${e.code}): ${e.message}; skipping`);
          skipped.push(`${card.id}: claim refused (${e.code})`);
          continue;
        }
        throw e;
      }
      started++;
    }
    return { started, skipped, killed: false };
  }

  /** Claim a card (conditional, nonce-checked in the local backend) and run its assignee;
   *  closes the card when the run settles. The claim is a comment, never a note (R5). */
  private async start(card: BoardCard): Promise<void> {
    const spec = this.opts.specs.get(card.assignee!)!;
    const board = this.opts.board;
    const runId = `${stamp()}-${spec.name}`;
    await board.update(card.id, { status: "doing", claim: { pid: process.pid, host: hostname(), run_id: runId } });
    await board.comment(card.id, `dispatcher: claimed for local run ${runId}`, "dispatcher");
    // upstream = the original edges (N1): blocked_by loses done ids on a block, upstream never does
    const blockers = await Promise.all((card.upstream ?? card.blocked_by).map((id) => board.get(id)));
    const task = cardTask(card, blockers);
    this.opts.log?.(`▶ ${spec.name} on card ${card.id}: ${card.title}`);
    const done = this.run(spec, card, task, runId);
    this.inflight.set(spec.name, done);
    done.finally(() => this.inflight.delete(spec.name)).catch(() => {});
  }

  private async run(spec: AgentSpec, card: BoardCard, task: string, runId: string): Promise<void> {
    const board = this.opts.board;
    const runsDir = this.opts.runsDir ?? RUNS_DIR;
    /** A finished run MUST close its card; a transient board error is retried, and a close
     *  that still fails leaves a marker comment so a restart never re-runs the run (R3). */
    const close = async (status: "done" | "blocked" | "todo", note?: string): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        try {
          await board.update(card.id, note !== undefined ? { status, note } : { status });
          return true;
        } catch (e) {
          if (attempt >= 3) {
            this.opts.log?.(`✗✗ could not close card ${card.id} after run ${runId} (${errText(e)}); marking it do-not-requeue`);
            try {
              await board.comment(card.id, `dispatcher: close failed after run ${runId} (status ${status}): ${errText(e)} — run finished; not requeuing`, "dispatcher");
            } catch {
              this.opts.log?.(`✗✗✗ could not even comment on card ${card.id}; it will need manual attention`);
            }
            return false;
          }
          const { promise: tick, resolve: wake } = Promise.withResolvers<void>();
          setTimeout(wake, 200 * attempt);
          await tick;
        }
      }
    };
    let r: RunResult;
    try {
      r = await runAgent(spec, {
        runId,
        task,
        provider: this.opts.provider(spec),
        naive: this.opts.naive ?? null,
        approver: this.opts.approver ?? denyAll,
        runsDir,
        board, // so board_* tools work inside dispatched runs (real hand-offs)
        log: (l) => this.opts.log?.(`  ${l}`),
      });
    } catch (e) {
      await close("blocked", `dispatcher error: ${errText(e)}`);
      this.opts.log?.(`✗ card ${card.id} blocked: ${errText(e)}`);
      return;
    }
    const money = `$${(r.spent_micro_usd / 1e6).toFixed(4)}`;
    if (r.status === "done") {
      await close("done", `done: run ${r.run_id}, ${money} — ${summary(r)}`);
      this.opts.log?.(`✓ card ${card.id} done: run ${r.run_id}, ${money}`);
    } else if (r.status === "killed") {
      // The kill switch stops spend, not the work: requeue so the loop picks the card up
      // again once runs/KILL is gone. (Any other failure blocks the card with the error.)
      if (await close("todo")) {
        await board.comment(card.id, `dispatcher: requeued — run ${r.run_id} was killed by the kill switch`, "dispatcher").catch(() => {});
        this.opts.log?.(`■ card ${card.id} requeued: run ${r.run_id} killed`);
      }
    } else {
      await close("blocked", `${r.status}: run ${r.run_id}, ${money} — ${r.error ?? "(no error text)"}`);
      this.opts.log?.(`✗ card ${card.id} blocked: run ${r.run_id} ended ${r.status}`);
    }
  }
}

/** One Studio Head cycle turn: the spec, a fixed mechanical task, and a provider. */
export interface HeadCycle {
  spec: AgentSpec;
  /** Mechanism only — the CLI's task names no game, genre, or design content. */
  task: string;
  provider: (spec: AgentSpec) => Provider;
}

export interface StudioLoopOptions extends DispatchOptions {
  pollS?: number;
  once?: boolean;
  /** Run one head turn every N minutes (default off; the plan uses 120). */
  headEveryMin?: number;
  /** The head cycle config; without it no head turn ever runs. */
  head?: HeadCycle;
  /** Auto-start trigger: true when a Greenlight pick exists in the ledger (topic greenlight.pick). */
  hasGreenlightPick?: () => boolean;
  /** Run one head turn at startup regardless of the board (operator restart, dry run). */
  headNow?: boolean;
  /** Test seams: a fake clock and an instant sleep make the cadence testable without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: checked after each sleep; the loop exits (cleanly, waiting for runs) when true. */
  shouldStop?: () => boolean;
}

/** The studio loop: requeue orphans, then pass/sleep until killed or (with once) after one pass.
 *  With a head cycle configured, one Studio Head turn runs per cadence tick (single-flight) and
 *  once at startup when the board is empty but a Greenlight pick exists — so the studio starts
 *  work after the pick without a human. */
export async function studioLoop(opts: StudioLoopOptions): Promise<void> {
  const d = new Dispatcher(opts);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  const lock = acquireStudioLock(opts.runsDir ?? RUNS_DIR); // one dispatcher per runs dir (R2)
  try {
    const requeued = await d.requeueOrphans();
    if (requeued) log(`startup: requeued ${requeued} orphaned card(s)`);

    // Studio Head cycle — one turn in flight at a time; spend caps apply inside runAgent.
    let headRun: Promise<void> | null = null;
    let lastHeadAt = now();
    const runsDir = opts.runsDir ?? RUNS_DIR;
    const runHead = () => {
      if (killSwitchOn(runsDir)) return log("kill switch on: no studio-head turn");
      const h = opts.head!;
      lastHeadAt = now();
      headRun = (async () => {
        log("▶ studio-head cycle turn");
        try {
          const r = await runAgent(h.spec, {
            task: h.task,
            provider: h.provider(h.spec),
            naive: opts.naive ?? null,
            approver: opts.approver ?? denyAll,
            runsDir: opts.runsDir ?? RUNS_DIR,
            board: opts.board,
            log: (l) => log(`  ${l}`),
          });
          log(`studio-head turn ${r.status} in ${r.turns} turns ($${(r.spent_micro_usd / 1e6).toFixed(4)}) → ${r.run_id}`);
        } catch (e) {
          log(`studio-head turn failed: ${errText(e)}`);
        } finally {
          headRun = null;
        }
      })();
    };

    const headOn = opts.head !== undefined && opts.headEveryMin !== undefined;
    if (headOn && opts.headNow) {
      log("--head-now: one studio-head turn now");
      runHead();
    } else if (headOn && !(await opts.board.list()).length && opts.hasGreenlightPick?.()) {
      log("board is empty and a Greenlight pick exists: one studio-head turn now");
      runHead();
    }

    for (;;) {
      const res = await d.pass();
      if (res.killed) {
        log("kill switch on: not dispatching; waiting for in-flight runs, then exiting");
        break;
      }
      if (headOn && !headRun && now() - lastHeadAt >= opts.headEveryMin! * 60_000) runHead();
      if (opts.once) break;
      if (!res.started && !res.skipped.length) log("board idle");
      await sleep(Math.max(1, opts.pollS ?? 10) * 1000);
      if (opts.shouldStop?.()) break;
    }
    await d.wait(); // both --once and a kill let started runs finish and close their cards
    if (headRun) await headRun;
    log("dispatcher exit");
  } finally {
    lock.release();
  }
}
