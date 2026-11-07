// studio_status: a read-only view of the studio for the Studio Head (and anyone else granted it).
// Reads runs/ (run.json, output.json, spend.jsonl) and agents/. Never writes.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolContext, ToolImpl, ToolOutput } from "./impl.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runsDirOf = (ctx: ToolContext) => ctx.runsDir ?? path.join(ROOT, "runs");
const MAX = 40_000;
const out = (v: unknown): ToolOutput => {
  const s = JSON.stringify(v);
  return { content: s.length <= MAX ? s : `${s.slice(0, MAX)}…[truncated ${s.length - MAX} chars]` };
};

async function readRunMeta(dir: string, id: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, id, "run.json"), "utf8"));
  } catch {
    return undefined;
  }
}

const studioRuns: ToolImpl = {
  description: "List the studio's most recent agent runs (newest first): id, agent, status, turns, cost in USD, start time, task.",
  input: z.object({ limit: z.number().int().min(1).max(50).default(15).describe("How many runs to return") }).strict(),
  async run({ limit }, ctx) {
    const dir = runsDirOf(ctx);
    let names: string[] = [];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "chat").map((d) => d.name).sort().reverse();
    } catch { /* no runs yet */ }
    const runs: unknown[] = [];
    for (const id of names) {
      if (runs.length >= (limit ?? 15)) break;
      const m = await readRunMeta(dir, id);
      if (!m) continue;
      runs.push({ id, agent: m.agent, status: m.status, turns: m.turns, cost_usd: (m.spent_micro_usd ?? 0) / 1e6, started_at: m.started_at, task: String(m.task ?? "").slice(0, 160) });
    }
    return out({ runs });
  },
};

const studioRun: ToolImpl = {
  description: "Details of one run by id: status, cost, turns, error if any, and its final output (clipped).",
  input: z.object({ run_id: z.string().min(3).max(120).regex(/^[\w.-]+$/, "a run id from studio_runs") }).strict(),
  async run({ run_id }, ctx) {
    const dir = runsDirOf(ctx);
    const m = await readRunMeta(dir, run_id);
    if (!m) return { content: `no run "${run_id}"; list ids with studio_runs`, is_error: true };
    let output: unknown = m.output;
    try {
      output = JSON.parse(await readFile(path.join(dir, run_id, "output.json"), "utf8"));
    } catch { /* output stays as in run.json */ }
    return out({ id: run_id, agent: m.agent, status: m.status, turns: m.turns, cost_usd: (m.spent_micro_usd ?? 0) / 1e6, error: m.error, task: String(m.task ?? "").slice(0, 600), output });
  },
};

const studioSpend: ToolImpl = {
  description: "Total inference spend recorded in the studio ledger: overall, per agent, and per day (USD).",
  input: z.object({}).strict(),
  async run(_input, ctx) {
    let text = "";
    try {
      text = await readFile(path.join(runsDirOf(ctx), "spend.jsonl"), "utf8");
    } catch { /* no spend yet */ }
    const byAgent: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let total = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts: string; agent: string; micro_usd: number };
        total += e.micro_usd;
        byAgent[e.agent] = (byAgent[e.agent] ?? 0) + e.micro_usd;
        const day = e.ts.slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + e.micro_usd;
      } catch { /* torn line */ }
    }
    const usd = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / 1e6]));
    return out({ total_usd: total / 1e6, by_agent_usd: usd(byAgent), by_day_usd: usd(byDay) });
  },
};

const studioAgents: ToolImpl = {
  description: "The studio's agent roster from the specs in agents/: name, department, runner, model, per-task and daily budget (USD).",
  input: z.object({}).strict(),
  async run() {
    const { loadAllAgents } = await import("../load.ts"); // lazy: load.ts imports the capability registry
    const { ok, errors } = await loadAllAgents();
    return out({
      agents: ok.map((s) => ({ name: s.name, dept: s.dept, runner: s.runner, model: s.model, description: s.description, max_task_usd: s.budget.max_task_usd, cap_usd: s.budget.cap_usd, period: s.budget.period })),
      spec_errors: errors.map((e) => e.message),
    });
  },
};

export const studioStatusTools: Record<string, ToolImpl> = {
  studio_runs: studioRuns,
  studio_run: studioRun,
  studio_spend: studioSpend,
  studio_agents: studioAgents,
};
