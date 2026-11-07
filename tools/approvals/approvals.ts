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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const APPROVALS_FILE = process.env.STUDIO_APPROVALS_FILE ?? path.join(ROOT, "runs", "approvals.jsonl");

export type ApprovalEvent =
  | { event: "requested"; id: string; ts: string; agent: string; run_id: string; tool: string; input: unknown }
  | { event: "approved" | "denied"; id: string; ts: string; who: string; note?: string; nonce: string }
  | { event: "expired"; id: string; ts: string; nonce: string };

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

/** A request nobody answered in time expires; not a human action, but ledgered like every terminal
 *  decision. Returns true only when this expiry is the winning terminal event. */
function expire(id: string, file: string, ledgerFile: string): boolean {
  if (get(id, file)?.state !== "pending") return false;
  const ts = new Date().toISOString();
  const nonce = randomBytes(8).toString("hex");
  appendEvent({ event: "expired", id, ts, nonce }, file);
  const rec = winnerOf(id, "expired", nonce, file);
  if (!rec) return false;
  logDecision(rec, "expired", ts, "timeout", undefined, ledgerFile);
  return true;
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
    const rec = decide(id, cmd === "approve", "operator", note);
    if (!rec) { console.error(`no pending approval ${id}`); process.exit(1); }
    console.log(`${rec.state} ${rec.id}${note ? ` — ${note}` : ""}`);
  } else {
    console.error('usage: approvals list | show <id> | approve <id> [--note "..."] | deny <id> --note "..."');
    process.exit(2);
  }
}
