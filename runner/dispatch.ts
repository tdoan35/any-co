// The studio dispatcher (T4): polls the board and runs local agents on due cards — the local
// twin of Naïve's board clock. Same rules the hosted clock applies, so the board reads the same
// on both backends: one doing card per assignee, blocked cards wait, done needs a note.
// scripts/studio-loop.ts is the CLI (`npm run studio`); the logic lives here so tests drive it.
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { RUNS_DIR, stamp, runAgent, denyAll, type Approver, type RunResult } from "./run.ts";
import { killSwitchOn } from "./spend.ts";
import type { AgentSpec } from "./spec.ts";
import type { Provider } from "./types.ts";
import type { NaiveClient } from "./providers.ts";
import { artMerge, gameRepoOfClone, type ArtMergeOptions, type ArtMergeResult } from "../tools/art/merge.ts";
import { BoardError, completeSupersedes, type Board, type BoardCard, type BoardComment } from "./board/index.ts";

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
  /** T46: the mechanical art-only merge run when an artist's card closes done with complete:true (default: tools/art/merge.ts). */
  artMerge?: (gameDir: string, branch: string, opts: ArtMergeOptions) => Promise<ArtMergeResult>;
  /** Where art.merge ledger decisions go (default: the studio ledger). */
  ledgerFile?: string;
}

/** Agents whose finished branches are art-only by role: their done cards trigger the mechanical merge (T46). */
export const ART_AGENTS = new Set(["art-director", "sprite-artist", "sprite-artist-b", "env-ui-artist", "env-ui-artist-b"]);

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
export const TAKEOVER_MUTEX = "studio.lock.takeover";

/**
 * Create `path` with exactly `content`, visible atomically: write to a unique temp then
 * create-exclusive link. A wx write is two syscalls (open O_CREAT|O_EXCL, write), so a concurrent
 * reader can see an EMPTY file mid-create and misread it as stale garbage (R26 #1). With link,
 * a file at the path is always complete.
 * Returns false if the path exists (someone else won).
 */
function createAtomically(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeFileSync(tmp, content);
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* tmp already gone */
    }
  }
}

/** A stale takeover mutex (dead holder) is removable; anything ambiguous means "live, retry":
 *  with atomic creates a present file is always complete, and an unreadable/vanished one is
 *  transient — deleting it could kill a holder mid-create (R26 #1). */
function staleMutex(mutex: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(mutex, "utf8");
  } catch {
    return false; // vanished between create and read: a live taker owns it; wait, don't delete
  }
  if (raw.trim() === "") return false; // empty cannot exist with atomic creates; treat as live
  try {
    const held = JSON.parse(raw) as { pid?: unknown; host?: unknown };
    const pid = typeof held.pid === "number" ? held.pid : NaN;
    const host = typeof held.host === "string" ? held.host : "";
    if (host && host !== hostname()) return false;
    return !(Number.isFinite(pid) && pidAlive(pid));
  } catch {
    return true; // unparseable: no coherent holder (holders always write parseable JSON) — replaceable
  }
}

const MUTEX_WAIT_MS = 25;
const MUTEX_PARK = new Int32Array(new SharedArrayBuffer(4));
/** Sync park between attempts (Atomics.wait), so a live takeover mutex starves nobody and no
 *  busy-spin burns CPU; works because the lock API is synchronous by contract. */
function mutexWait(): void {
  Atomics.wait(MUTEX_PARK, 0, 0, MUTEX_WAIT_MS);
}

export function acquireStudioLock(runsDir: string): StudioLock {
  mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, "studio.lock");
  const mutex = path.join(runsDir, TAKEOVER_MUTEX);
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() });
  // create-exclusive (N4): two loops started at the same instant cannot both pass a check-then-write
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
    if (createAtomically(file, mine)) {
      return { file, release: () => { try { rmSync(file); } catch { /* already gone */ } } };
    }
    mutexWait(); // bounded pause between attempts (sync park, no busy spin)

    // Read the holder under no lock first: a live holder refuses us; a provably dead one is stale.
    // With atomic creates the file, when present, is always complete (R26 #1).
    let staleText = "";
    let present = false;
    let stale = false;
    try {
      staleText = readFileSync(file, "utf8");
      present = true;
      const held = JSON.parse(staleText) as { pid?: unknown; host?: unknown };
      const pid = typeof held.pid === "number" ? held.pid : NaN;
      const host = typeof held.host === "string" ? held.host : "";
      const live = host && host !== hostname() ? true : Number.isFinite(pid) && pidAlive(pid);
      stale = !live;
    } catch {
      stale = false; // vanished mid-read: treat as live-until-proven; a fast retry re-reads
    }
    if (!stale) throw new Error(`another studio loop holds ${file}; refusing to start. If it is dead, remove the file.`);
    // Stale takeover under a mutex (R24): without it, B can delete A's just-written live lock
    // while C wx-creates in the gap, and two winners appear.
    let held_mutex = false;
    try {
      if (!createAtomically(mutex, mine)) {
        if (staleMutex(mutex)) {
          rmSync(mutex); // dead mutex holder: recover it and retry the wx next round
        } else {
          mutexWait(); // live takeover in progress: park 25ms (sync), don't burn attempts
        }
        continue;
      }
      held_mutex = true;
    } catch (e) {
      rmSync(mutex, { force: true }); // our own half-created mutex; never a live holder's
      throw e;
    }
    try {
      // Under the mutex, re-read and re-verify; only then remove the lock — and only a NON-EMPTY
      // one whose content we re-verified dead (R26 #2): an absent/empty lock must not be rm'd,
      // a fast-path taker's wx in that gap would lose its lock to our cleanup.
      let current = "";
      let present = false;
      try {
        current = readFileSync(file, "utf8");
        present = true;
      } catch {
        present = false; // vanished: nothing to remove; the mutex still guards our wx
      }
      if (present && current !== staleText) {
        const held = JSON.parse(current) as { pid?: unknown };
        const pid = typeof held.pid === "number" ? held.pid : NaN;
        if (Number.isFinite(pid) && pidAlive(pid)) continue; // a live taker won: start over
      }
      if (present) {
        try {
          rmSync(file);
        } catch {
          /* already gone */
        }
      }
      if (createAtomically(file, mine)) {
        return { file, release: () => { try { rmSync(file); } catch { /* already gone */ } } };
      }
      // someone raced the wx: loop and re-read
    } finally {
      if (held_mutex) {
        try {
          rmSync(mutex);
        } catch {
          /* already gone */
        }
      }
    }
  }
  throw new Error(`could not take ${file}: another studio loop is starting at the same time`);
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Comment authors whose words steer the run (T37). The dispatcher's and other agents' comments stay out (no feedback loops). */
export const STEERING_AUTHORS = new Set(["operator", "studio-head"]);
/** Total characters of operator notes put into a task; the newest notes are kept. */
export const OPERATOR_NOTES_CAP = 4000;

/** A steering comment: author "operator" or "studio-head" (local names; on Naïve the runner tags its own comments),
 *  or a person on the Naïve board (`usr_` principal: a human commenting in the app). */
export function isSteering(c: BoardComment): boolean {
  return STEERING_AUTHORS.has(c.author) || c.author.startsWith("usr_");
}

/** "Operator notes", oldest → newest, clipped to `cap` characters by dropping the OLDEST first (a single note over the cap keeps its end). */
export function operatorNotes(comments: BoardComment[], cap = OPERATOR_NOTES_CAP): string | null {
  const notes = comments.filter(isSteering).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (notes.length === 0) return null;
  const lines = notes.map((c) => `- ${c.created_at} ${c.author}: ${c.body.trim()}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length ? 1 : 0); // + the newline joining it to the kept ones
    if (used + add <= cap) {
      kept.unshift(lines[i]);
      used += add;
      continue;
    }
    if (kept.length === 0) kept.unshift(`- …${lines[i].slice(-(cap - 3))}`); // the newest alone is over the cap: keep its end
    break;
  }
  const dropped = notes.length - kept.length;
  return `--- Operator notes (card comments from the operator / Studio Head, newest last${dropped ? `; ${dropped} older clipped` : ""}) ---\n${kept.join("\n")}`;
}

/** The task handed to an agent: the card, what its finished blockers produced, and the operator's comments on the card. */
export function cardTask(card: BoardCard, blockers: BoardCard[], comments: BoardComment[] = []): string {
  const parts = [`# ${card.title}`, card.body].filter(Boolean);
  if (blockers.length) {
    parts.push(
      "--- Upstream results (done cards this card waited on) ---\n" +
        blockers.map((b) => `## ${b.title} (${b.id})\n${b.note ?? "(no note)"}`).join("\n\n"),
    );
  }
  const notes = operatorNotes(comments);
  if (notes) parts.push(notes);
  return parts.join("\n\n");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The agent's own words about what's left: its summary or notes (top level, else one level down), else the output. */
function agentNote(r: RunResult): string {
  const o = r.output as Record<string, unknown>;
  const pick = (x: Record<string, unknown>) => [x.summary, x.notes].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const nested = Object.values(o).filter(isObject).map(pick).find(Boolean);
  const text = pick(o) ?? nested;
  if (!text) return summary(r);
  return text.length > 600 ? text.slice(0, 600) + "…" : text;
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
    // T38 safety net: finish any supersede left half-done (dependents still on a replaced card) before starting work
    await completeSupersedes(board, this.opts.log).catch((e: unknown) => this.opts.log?.(`supersede check failed: ${errText(e)}`));
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
    // operator steering rides card comments (T37); a comment read that fails must not block the run
    const comments = await board.comments(card.id).catch((e: unknown) => {
      this.opts.log?.(`card ${card.id}: could not read comments (${errText(e)}); starting without operator notes`);
      return [] as BoardComment[];
    });
    const task = cardTask(card, blockers, comments);
    this.opts.log?.(`▶ ${spec.name} on card ${card.id}: ${card.title}`);
    const done = this.run(spec, card, task, runId);
    this.inflight.set(spec.name, done);
    done.finally(() => this.inflight.delete(spec.name)).catch(() => {});
  }

  /**
   * T46: merge the artist's agent/<name> branch into the game repo's main with no LLM (tools/art/merge.ts). The game repo is
   * the run clone's origin. The outcome goes on the card as a comment; a refusal is left for the head (it cards a tech-lead
   * merge). Never throws: a merge problem must not take the dispatcher down.
   */
  private async autoArtMerge(spec: AgentSpec, card: BoardCard, runId: string, runsDir: string): Promise<void> {
    const board = this.opts.board;
    const branch = `agent/${spec.name}`;
    try {
      const gameDir = gameRepoOfClone(path.join(runsDir, runId, "workspace", "game"));
      if (!gameDir) {
        await board.comment(card.id, `art-merge: skipped — run ${runId} has no game clone with a local origin; card a tech-lead merge if ${branch} needs landing`, "dispatcher");
        return;
      }
      const r = await (this.opts.artMerge ?? artMerge)(gameDir, branch, { runsDir, ledgerFile: this.opts.ledgerFile, agent: "dispatcher", run_id: runId });
      const text = r.ok
        ? `art-merge: merged ${branch} into main mechanically (${r.mode}, ${r.assets ?? 0} asset file(s), gate ok) @ ${(r.merged ?? "").slice(0, 10)}`
        : `art-merge: refused — ${r.reason}. Card a tech-lead merge for ${branch}.`;
      await board.comment(card.id, text, "dispatcher");
      this.opts.log?.(`${r.ok ? "⇢" : "⇢✗"} card ${card.id} ${text}`);
    } catch (e) {
      this.opts.log?.(`✗ card ${card.id}: art-merge error (${errText(e)}); left for the head`);
      await board.comment(card.id, `art-merge: error — ${errText(e)}. Card a tech-lead merge for ${branch}.`, "dispatcher").catch(() => {});
    }
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
    if (r.status === "done" && isObject(r.output) && r.output.complete === false) {
      // ran to the end but says the work isn't done (T29): never close it as done
      await close("blocked", `not complete: run ${r.run_id}, ${money} — ${agentNote(r)}`);
      this.opts.log?.(`■ card ${card.id} blocked: run ${r.run_id} reported complete:false`);
    } else if (r.status === "done") {
      await close("done", `done: run ${r.run_id}, ${money} — ${summary(r)}`);
      this.opts.log?.(`✓ card ${card.id} done: run ${r.run_id}, ${money}`);
      if (ART_AGENTS.has(spec.name) && isObject(r.output) && r.output.complete === true && process.env.STUDIO_AUTO_ART_MERGE !== "off")
        await this.autoArtMerge(spec, card, r.run_id, runsDir);
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
  /** Mechanism only — the CLI's task names no game, genre, or design content. A function is called per turn
   *  (so the task can carry the current time). */
  task: string | (() => string);
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
            task: typeof h.task === "function" ? h.task() : h.task,
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
