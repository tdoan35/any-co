// Studio ledger: decisions and human interventions, append-only JSONL (CLAUDE.md, rule 4).
// Local backend for now (runs/ledger.jsonl); the plan moves it to an MCP tool on a Naïve App.
// Agents reach it through the `studio_ledger` capability, so swapping the backend changes no spec.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Follows STUDIO_RUNS_DIR like runAgent does, so a moved runs dir never splits the ledger (R20).
export const LEDGER_FILE = process.env.STUDIO_LEDGER_FILE ?? path.join(process.env.STUDIO_RUNS_DIR ? path.resolve(process.env.STUDIO_RUNS_DIR) : path.join(ROOT, "runs"), "ledger.jsonl");

export interface DecisionEntry {
  kind: "decision";
  ts: string;
  agent: string;
  run_id: string;
  topic: string; // e.g. "greenlight.pick", "scope.cut"
  decision: string;
  rationale: string;
  alternatives?: Array<{ option: string; why_not: string }>;
  refs?: string[]; // run ids, file paths, URLs the decision rests on
}

export interface InterventionEntry {
  kind: "intervention";
  ts: string;
  who: string; // the human, by role
  action: string;
  reason: string;
  /** harness | account | steering | approval; missing on pre-T17 lines reads as "uncategorized". */
  category?: InterventionCategory;
}

export const INTERVENTION_CATEGORIES = ["harness", "account", "steering", "approval"] as const;
export type InterventionCategory = (typeof INTERVENTION_CATEGORIES)[number];

/** Backfill keyword table (first match wins), T17: account beats steering beats approval beats harness. */
export const CATEGORY_RULES: Array<{ category: InterventionCategory; re: RegExp; why: string }> = [
  // First match wins. Order matters: review verdicts ("R4b APPROVE") and credit mentions appear in harness entries,
  // so the specific human-action patterns come first and the broad words were narrowed (orchestrator, 2026-11-07).
  { category: "approval", re: /^(approved|denied)\b|^(Ty|operator|human) (approved|denied)\b|\bart sign-?off\b|\bgo\/no-go\b/i, why: "a human approve/deny of a gated action or checkpoint" },
  { category: "account", re: /provision|email identity|inbox|app id|api key|keys? (in|into|to) \.env|butler install|Registered Naïve agent record|Naïve email|studio-site app/i, why: "keys, accounts, provisioning" },
  { category: "steering", re: /pressed start|\bstarted (the |a )?\S*.*\brun\b|\bkilled .*\brun\b|restarted .*(run|Tech Lead|Art Director|Director)|design doc accepted|retrying the design|started the studio's game coders/i, why: "starting/stopping studio runs, picks" },
  { category: "harness", re: /./, why: "everything else is repo/infra work" },
];

export const categorize = (action: string): InterventionCategory => CATEGORY_RULES.find((r) => r.re.test(action))!.category;

export interface ApprovalEntry {
  kind: "approval";
  ts: string;
  request_id: string; // approvals.ts id, ties the entry to runs/approvals.jsonl
  agent: string;
  run_id: string;
  tool: string;
  decision: "approved" | "denied" | "expired";
  who: string; // "operator", "auto (--approve-all)", "timeout", ...
  note?: string;
  input_summary: string; // clipped JSON of the tool input
}

export type LedgerEntry = DecisionEntry | InterventionEntry | ApprovalEntry;

export function append(e: LedgerEntry, file = LEDGER_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + "\n");
}

export function read(file = LEDGER_FILE): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as LedgerEntry]; } catch { return []; }
  });
}

export interface RecategorizeResult {
  matched: Array<{ index: number; ts: string; action: string; from: string; to: string }>;
  bytes: number;
}

/**
 * One-off migration (T17): assign a category to today's uncategorized operator interventions by
 * keyword (CATEGORY_RULES, first match wins). Dry-run prints the proposal; `apply` rewrites the
 * file atomically (temp + rename) keeping every line byte-for-byte except the added `"category"`
 * key on matched entries, and appends one harness intervention noting the backfill. Idempotent:
 * entries that already carry a category are left untouched, so a second run is a no-op.
 */
export function recategorize(opts: { file?: string; apply?: boolean; log?: (line: string) => void } = {}): RecategorizeResult {
  const file = opts.file ?? LEDGER_FILE;
  const log = opts.log ?? (() => {});
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const out: RecategorizeResult = { matched: [], bytes: 0 };
  const rewritten = lines.map((line, index) => {
    if (!line.trim()) return line;
    let e: LedgerEntry;
    try {
      e = JSON.parse(line) as LedgerEntry;
    } catch {
      return line;
    }
    if (e.kind !== "intervention" || e.category !== undefined || e.who !== "operator") return line;
    const to = categorize(e.action);
    out.matched.push({ index, ts: e.ts, action: e.action, from: "uncategorized", to });
    log(`${index}\t${e.ts}\t[${to}]\t${e.action.slice(0, 80)}`);
    // Re-stringify with `category` last so the rest of the object is byte-identical on old entries.
    const ordered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) if (k !== "category") ordered[k] = v;
    ordered.category = to;
    return JSON.stringify(ordered);
  });
  if (!opts.apply || out.matched.length === 0) {
    out.bytes = lines.join("\n").length;
    if (opts.apply) log("nothing to do: 0 uncategorized operator interventions");
    return out;
  }
  const note: InterventionEntry = {
    kind: "intervention",
    ts: new Date().toISOString(),
    who: "operator",
    action: "ledger recategorize backfill (T17)",
    reason: `assigned categories to ${out.matched.length} uncategorized interventions by keyword table (tools/ledger/ledger.ts CATEGORY_RULES); one-off migration, idempotent`,
    category: "harness",
  };
  rewritten.push(JSON.stringify(note));
  const body = `${rewritten.join("\n")}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  out.bytes = statSync(file).size;
  log(`applied: ${out.matched.length} entries recategorized, backfill note appended (${file})`);
  return out;
}

/**
 * Operator-only CLI commands refuse a process an agent started (T40): game_exec and the run checkpoint set ANYCO_AGENT,
 * so an agent cannot write an "operator" intervention or decide an approval through the CLI. Agents log through
 * log_decision, which records them as the agent.
 */
export function refuseAgentCli(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const agent = env.ANYCO_AGENT?.trim();
  return agent ? `refused: "${command}" is an operator command and this process was started by agent "${agent}" (ANYCO_AGENT is set); agents record decisions with log_decision` : null;
}

/** CLI for the human side: node --import tsx tools/ledger/ledger.ts intervention "<action>" "<reason>" [--category ...] | recategorize [--apply] | list */
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const [cmd, a, b] = argv;
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const refused = cmd === "intervention" || (cmd === "recategorize" && argv.includes("--apply")) ? refuseAgentCli(`ledger ${cmd}`) : null;
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
  if (cmd === "intervention" && a && b) {
    const raw = flag("--category") ?? "harness";
    if (!INTERVENTION_CATEGORIES.includes(raw as InterventionCategory)) {
      console.error(`invalid category "${raw}"; one of ${INTERVENTION_CATEGORIES.join(", ")}`);
      process.exit(2);
    }
    const category = raw as InterventionCategory;
    append({ kind: "intervention", ts: new Date().toISOString(), who: "operator", action: a, reason: b, category });
    console.log(`logged (${category})`);
  } else if (cmd === "recategorize") {
    const apply = argv.includes("--apply");
    recategorize({ file: LEDGER_FILE, apply, log: (line) => console.log(line) });
  } else if (cmd === "list") {
    for (const e of read())
      console.log(
        e.kind === "decision" ? `${e.ts} decision ${e.topic} by ${e.agent}: ${e.decision}`
          : e.kind === "approval" ? `${e.ts} approval ${e.request_id} ${e.tool} for ${e.agent}: ${e.decision} by ${e.who}`
            : `${e.ts} INTERVENTION [${e.category ?? "uncategorized"}] ${e.action}: ${e.reason}`,
      );
  } else {
    console.error('usage: ledger.ts intervention "<action>" "<reason>" [--category harness|account|steering|approval] | recategorize [--apply] | list');
    process.exit(2);
  }
}
