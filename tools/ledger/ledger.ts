// Studio ledger: decisions and human interventions, append-only JSONL (CLAUDE.md, rule 4).
// Local backend for now (runs/ledger.jsonl); the plan moves it to an MCP tool on a Naïve App.
// Agents reach it through the `studio_ledger` capability, so swapping the backend changes no spec.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LEDGER_FILE = process.env.STUDIO_LEDGER_FILE ?? path.join(ROOT, "runs", "ledger.jsonl");

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
}

export type LedgerEntry = DecisionEntry | InterventionEntry;

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

/** CLI for the human side: node --import tsx tools/ledger/ledger.ts intervention "<action>" "<reason>" | list */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "intervention" && a && b) {
    append({ kind: "intervention", ts: new Date().toISOString(), who: "operator", action: a, reason: b });
    console.log("logged");
  } else if (cmd === "list") {
    for (const e of read()) console.log(e.kind === "decision" ? `${e.ts} decision ${e.topic} by ${e.agent}: ${e.decision}` : `${e.ts} INTERVENTION ${e.action}: ${e.reason}`);
  } else {
    console.error('usage: ledger.ts intervention "<action>" "<reason>" | list');
    process.exit(2);
  }
}
