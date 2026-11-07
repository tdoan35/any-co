// Local spend ledger, budget math, and kill switch. Deterministic code only (CLAUDE.md, rule 5).
// Every priced call made by the local runner (model or tool) is appended to runs/spend.jsonl.
// Proxy calls are org-level on Naïve (not tied to an agent), so Naïve's per-agent budget does not
// apply to them; these checks are the only cap on local spend.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { microUsd, type AgentSpec } from "./spec.ts";

export interface SpendEntry {
  ts: string;
  run_id: string;
  agent: string;
  kind: "model" | "tool";
  what: string; // model id or tool name
  micro_usd: number;
}

export class SpendLedger {
  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  append(e: SpendEntry) {
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }

  entries(): SpendEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as SpendEntry];
        } catch {
          return []; // a torn last line after a crash must not block the runner
        }
      });
  }

  /** micro-USD spent since `since` (optionally by one agent). */
  total(since: Date, agent?: string): number {
    const t = since.getTime();
    return this.entries()
      .filter((e) => Date.parse(e.ts) >= t && (!agent || e.agent === agent))
      .reduce((s, e) => s + e.micro_usd, 0);
  }
}

/** Start of the current budget period, in local time. */
export function periodStart(period: "day" | "week" | "month", now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  if (period === "month") d.setDate(1);
  return d;
}

export interface Limits {
  run_cap: number; // micro-USD for this run
  agent_period_left: number; // micro-USD left in the agent's budget period
  global_day_left: number; // micro-USD left under LOCAL_SPEND_CAP_USD today
}

export const DEFAULT_LOCAL_DAILY_CAP_USD = 5;

export function limitsFor(spec: AgentSpec, ledger: SpendLedger, runCapUsd?: number, now = new Date()): Limits {
  const capEnv = Number(process.env.LOCAL_SPEND_CAP_USD);
  const globalCap = microUsd(Number.isFinite(capEnv) && capEnv > 0 ? capEnv : DEFAULT_LOCAL_DAILY_CAP_USD);
  const taskCap = microUsd(spec.budget.max_task_usd);
  return {
    run_cap: Math.min(taskCap, runCapUsd !== undefined ? microUsd(runCapUsd) : taskCap),
    agent_period_left: microUsd(spec.budget.cap_usd) - ledger.total(periodStart(spec.budget.period, now), spec.name),
    global_day_left: globalCap - ledger.total(periodStart("day", now)),
  };
}

/** Kill switch: `touch runs/KILL` (or set STUDIO_KILL=1) stops every local run before its next call. */
export function killSwitchOn(runsDir: string): boolean {
  return process.env.STUDIO_KILL === "1" || existsSync(path.join(runsDir, "KILL"));
}
