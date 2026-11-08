// Approval gate (AGENTS.md rule 4): every `ask`-gated tool call becomes a request in a
// file-backed queue (runs/approvals.jsonl, append-only JSONL like the ledger). A human decides
// from the terminal (`npm run approvals`), unattended runs poll for the decision, and every
// terminal decision — approve, deny, or timeout — is written to the studio ledger.
// Current state is a fold over the events; the first terminal event for an id wins.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { append as ledgerAppend, LEDGER_FILE } from "../ledger/ledger.ts";
import type { Approver } from "../../runner/run.ts";
import { orphanStatus } from "../../runner/liveness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const APPROVALS_FILE = process.env.STUDIO_APPROVALS_FILE ?? path.join(ROOT, "runs", "approvals.jsonl");
// Same env override as the runner's runs dir (runner/run.ts RUNS_DIR), so the CLI sweep, resume
// and the window read run.json from the same place when the layout moves.
const RUNS_DIR = process.env.STUDIO_RUNS_DIR ? path.resolve(process.env.STUDIO_RUNS_DIR) : path.join(ROOT, "runs");

export type ApprovalEvent =
  | { event: "requested"; id: string; ts: string; agent: string; run_id: string; tool: string; input: unknown }
  | { event: "approved" | "denied"; id: string; ts: string; who: string; note?: string; nonce: string }
  | { event: "expired"; id: string; ts: string; nonce: string; who?: string };

export interface ApprovalRecord {
  id: string;
  state: "pending" | "approved" | "denied" | "expired";
  ts: string; // when requested
  agent: string;
  run_id: string;
  tool: string;
  input: unknown;
  decided_ts?: string;
  who?: string;
  note?: string;
}

export interface ApprovalRequestInput {
  agent: string;
  run_id: string;
  tool: string;
  input: unknown;
}

function readEvents(file: string): ApprovalEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as ApprovalEvent]; } catch { return []; } // a torn last line is dropped
  });
}
function appendEvent(e: ApprovalEvent, file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  // A writer killed mid-append can leave a fragment without a newline; start our line with one
  // so the next event is not glued onto it (the fold already drops unparseable fragments).
  let sep = "";
  if (existsSync(file)) {
    const prev = readFileSync(file);
    if (prev.length > 0 && prev[prev.length - 1] !== 0x0a) sep = "\n";
  }
  appendFileSync(file, sep + JSON.stringify(e) + "\n");
}

/** Fold events into records, insertion order; the first terminal event for an id wins, and a duplicate
 *  requested never resurrects a decided record (same-second id collisions are ~1/65k, but cheap to guard). */
export function fold(file = APPROVALS_FILE): ApprovalRecord[] {
  const byId = new Map<string, ApprovalRecord>();
  for (const e of readEvents(file)) {
    if (e.event === "requested") {
      if (!byId.has(e.id)) byId.set(e.id, { id: e.id, state: "pending", ts: e.ts, agent: e.agent, run_id: e.run_id, tool: e.tool, input: e.input });
    } else {
      const rec = byId.get(e.id);
      if (!rec || rec.state !== "pending") continue;
      rec.state = e.event;
      rec.decided_ts = e.ts;
      if (e.event !== "expired") { rec.who = e.who; if (e.note) rec.note = e.note; }
      else if (e.who) rec.who = e.who; // expiry cause, e.g. "run ended"
    }
  }
  return [...byId.values()];
}

export function pending(file = APPROVALS_FILE): ApprovalRecord[] {
  return fold(file).filter((r) => r.state === "pending");
}

export function get(id: string, file = APPROVALS_FILE): ApprovalRecord | undefined {
  return fold(file).find((r) => r.id === id);
}

const newId = (d = new Date()) => `apr-${d.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;

export function request(req: ApprovalRequestInput, file = APPROVALS_FILE): string {
  const id = newId();
  appendEvent({ event: "requested", id, ts: new Date().toISOString(), agent: req.agent, run_id: req.run_id, tool: req.tool, input: req.input }, file);
  return id;
}

/** Clip the tool input for the ledger: same data, bounded size. */
const summarize = (input: unknown) => {
  const s = JSON.stringify(input) ?? "null";
  return s.length <= 400 ? s : `${s.slice(0, 400)}…`;
};

function logDecision(rec: ApprovalRecord, decision: "approved" | "denied" | "expired", ts: string, who: string, note: string | undefined, ledgerFile: string) {
  ledgerAppend({
    kind: "approval", ts, request_id: rec.id, agent: rec.agent, run_id: rec.run_id, tool: rec.tool,
    decision, who, ...(note ? { note } : {}), input_summary: summarize(rec.input),
  }, ledgerFile);
}

/** The folded record iff the first terminal event for id in file order is exactly the one just appended.
 *  Two processes can both see "pending" and both append; only the file-order winner may ledger.
 *  Identity is the event's random nonce, not its timestamp: two decisions in the same millisecond
 *  are still different events, and only one of them is the file-order first. */
function winnerOf(id: string, event: "approved" | "denied" | "expired", nonce: string, file: string): ApprovalRecord | null {
  const first = readEvents(file).find((e): e is Extract<ApprovalEvent, { event: "approved" | "denied" | "expired" }> => e.id === id && e.event !== "requested");
  if (first?.nonce !== nonce || first.event !== event) return null; // another process's event won — or a pre-nonce one, which always means lost
  return get(id, file) ?? null;
}

/** Record a human (or auto) decision. Returns the decided record, or null if the id is unknown,
 *  already terminal, or another process's terminal event landed first (then nothing is ledgered). */
export function decide(id: string, approve: boolean, who: string, note?: string, file = APPROVALS_FILE, ledgerFile = LEDGER_FILE): ApprovalRecord | null {
  if (get(id, file)?.state !== "pending") return null; // fast path: unknown or already decided
  const event = approve ? "approved" as const : "denied" as const;
  const ts = new Date().toISOString();
  const nonce = randomBytes(8).toString("hex");
  appendEvent({ event, id, ts, who, nonce, ...(note ? { note } : {}) }, file);
  const rec = winnerOf(id, event, nonce, file);
  if (!rec) return null; // lost the race: the fold already has another terminal event
  logDecision(rec, event, ts, who, note, ledgerFile);
  return rec;
}

/** Expire a pending request; not a human action, but ledgered like every terminal decision
 *  (`who` names the cause, e.g. "timeout" or "run ended"). Returns the decided record only
 *  when this expiry is the winning terminal event. */
function expireWith(id: string, who: string, file: string, ledgerFile: string): ApprovalRecord | null {
  if (get(id, file)?.state !== "pending") return null;
  const ts = new Date().toISOString();
  const nonce = randomBytes(8).toString("hex");
  appendEvent({ event: "expired", id, ts, nonce, who }, file);
  const rec = winnerOf(id, "expired", nonce, file);
  if (!rec) return null;
  logDecision(rec, "expired", ts, who, undefined, ledgerFile);
  return rec;
}

/** A request nobody answered in time expires. */
function expire(id: string, file: string, ledgerFile: string): boolean {
  return expireWith(id, "timeout", file, ledgerFile) !== null;
}

/** Expire every pending request of one run: the run crashed or ended, so its interrupted
 *  calls are answered by the runner with the crash notice and never run — approving later
 *  would ledger an intervention for a call that cannot happen. Ledgered as expired with
 *  who "run ended", never as a human intervention. */
export function expireForRun(run_id: string, file = APPROVALS_FILE, ledgerFile = LEDGER_FILE): ApprovalRecord[] {
  const out: ApprovalRecord[] = [];
  for (const r of pending(file)) {
    if (r.run_id !== run_id) continue;
    const rec = expireWith(r.id, "run ended", file, ledgerFile);
    if (rec) out.push(rec);
  }
  return out;
}

/** Why a request's run can never consume a decision, or null while it may still: the run finished
 *  (any status but "running") or is orphaned per runner/liveness.ts. A missing or unreadable
 *  run.json is "unknown" and stays decidable — never expire on a guess. */
export function runEndedReason(run_id: string, runsDir = RUNS_DIR): string | null {
  let run: Record<string, unknown>;
  try {
    run = JSON.parse(readFileSync(path.join(runsDir, run_id, "run.json"), "utf8"));
  } catch {
    return null;
  }
  if (run.status !== "running") return `run ${run_id} has ended (status ${String(run.status)})`;
  const v = orphanStatus(run);
  return v.orphaned ? `run ${run_id} is orphaned (${v.reason})` : null;
}

/** Pending requests whose run is still alive (or unknown). Pure read, for display (window weave). */
export function pendingLive(file = APPROVALS_FILE, runsDir = RUNS_DIR): ApprovalRecord[] {
  return pending(file).filter((r) => runEndedReason(r.run_id, runsDir) === null);
}

/** Expire every pending request whose run is finished or orphaned, as who "run ended" (ledgered
 *  as expired, never as an intervention). Returns the records this call expired. */
export function expireDeadRuns(file = APPROVALS_FILE, runsDir = RUNS_DIR, ledgerFile = LEDGER_FILE): ApprovalRecord[] {
  const out: ApprovalRecord[] = [];
  for (const r of pending(file)) {
    if (runEndedReason(r.run_id, runsDir) === null) continue;
    const rec = expireWith(r.id, "run ended", file, ledgerFile);
    if (rec) out.push(rec);
  }
  return out;
}

/** A human decision from the CLI: refuses (and expires) a request whose run has ended, so no
 *  intervention is ledgered for a call that can never run. */
export function decideHuman(
  id: string, approve: boolean, note?: string, file = APPROVALS_FILE, runsDir = RUNS_DIR, ledgerFile = LEDGER_FILE,
): { rec: ApprovalRecord } | { error: string } {
  const cur = get(id, file);
  if (!cur) return { error: `no approval ${id}` };
  if (cur.state !== "pending") return { error: `approval ${id} is already ${cur.state}${cur.who ? ` (by ${cur.who})` : ""}` };
  const dead = runEndedReason(cur.run_id, runsDir);
  if (dead) {
    expireWith(id, "run ended", file, ledgerFile);
    return { error: `refused: ${dead}, so this call can never run; request ${id} expired (who "run ended")` };
  }
  const rec = decide(id, approve, "operator", note, file, ledgerFile);
  return rec ? { rec } : { error: `approval ${id} was decided by another process first` };
}

/** An Approver for unattended runs: record the request, poll for a decision, expire on timeout. */
export function queueApprover(opts: { timeoutMs: number; pollMs?: number; file?: string; ledgerFile?: string }): Approver {
  const file = opts.file ?? APPROVALS_FILE;
  const ledgerFile = opts.ledgerFile ?? LEDGER_FILE;
  const pollMs = opts.pollMs ?? 500;
  return async (req) => {
    const id = request(req, file);
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const rec = get(id, file);
      if (rec && rec.state !== "pending") return rec.state === "approved";
      if (Date.now() >= deadline) return expire(id, file, ledgerFile) ? false : get(id, file)?.state === "approved";
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, pollMs);
      await promise;
    }
  };
}

const age = (ts: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

/** CLI for the human side: npm run approvals -- list | show <id> | approve <id> [--note "..."] | deny <id> --note "..." */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { note: { type: "string" } } });
  const [cmd, id] = positionals;
  if (cmd === "list") {
    for (const r of expireDeadRuns()) console.log(`expired ${r.id} (${r.tool}, ${r.agent}): run ${r.run_id} ended`);
    const rows = pending();
    if (!rows.length) console.log("no pending approvals");
    for (const r of rows) console.log(`${r.id}  ${age(r.ts).padStart(4)} ago  ${r.tool}  ${r.agent}  ${r.run_id}`);
  } else if (cmd === "show" && id) {
    const r = get(id);
    if (!r) { console.error(`no approval ${id}`); process.exit(1); }
    console.log(`id:         ${r.id}`);
    console.log(`state:      ${r.state}`);
    console.log(`requested:  ${r.ts} (${age(r.ts)} ago)`);
    console.log(`agent:      ${r.agent}   run: ${r.run_id}`);
    console.log(`tool:       ${r.tool}`);
    console.log(`input:      ${JSON.stringify(r.input)}`);
    if (r.decided_ts) console.log(`${r.state} ${r.decided_ts} by ${r.who}${r.note ? ` — ${r.note}` : ""}`);
  } else if ((cmd === "approve" || cmd === "deny") && id) {
    const note = values.note;
    if (cmd === "deny" && !note) { console.error('deny needs a note: --note "why"'); process.exit(2); }
    const res = decideHuman(id, cmd === "approve", note);
    if ("error" in res) { console.error(res.error); process.exit(1); }
    console.log(`${res.rec.state} ${res.rec.id}${note ? ` — ${note}` : ""}`);
  } else {
    console.error('usage: approvals list | show <id> | approve <id> [--note "..."] | deny <id> --note "..."');
    process.exit(2);
  }
}
