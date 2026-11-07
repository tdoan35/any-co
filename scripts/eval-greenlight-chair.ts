// Mechanical eval of a Greenlight Chair pick. Usage: npm run eval:greenlight-chair -- runs/<run_id>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MUST_HOURS_BUDGET } from "../tools/greenlight/feasibility.ts";
import { read as readLedger } from "../tools/ledger/ledger.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) { console.error("usage: npm run eval:greenlight-chair -- runs/<run_id>"); process.exit(2); }
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
if (!existsSync(path.join(dir, "output.json"))) { console.log(`run ${run.status}: no output`); process.exit(1); }
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const task = String(run.task);

// Parse verdicts and Critic estimates back out of the task (built by pickTask).
const sections = [...task.matchAll(/^## (.+?): (VETO|PASS_WITH_CUTS|PASS) \(([\s\S]*?)(?=^## |^# Pitches)/gm)];
const verdicts = new Map(sections.map((m) => [m[1], m[2]]));
const estimates = new Map(sections.map((m) => [m[1], new Map([...m[3].matchAll(/^- (.+): ([\d.]+)h$/gm)].map((e) => [e[1].trim(), Number(e[2])]))]));

const issues: string[] = [];
const pick = out.pick.working_title;
if (!verdicts.has(pick)) issues.push(`pick "${pick}" is not a pitch in the task`);
else if (verdicts.get(pick) === "VETO") issues.push(`pick "${pick}" was vetoed`);
const est = estimates.get(pick) ?? new Map();
let hours = 0;
for (const m of out.pick.adopted_must) {
  const h = est.get(m.item.trim());
  if (/\b(art pass|sprites?|playtest|bug ?fix|qa\b)/i.test(m.item)) issues.push(`adopted must "${m.item.slice(0, 50)}" looks like art/QA work (belongs in art_and_qa)`);
  if (h === undefined) issues.push(`adopted must "${m.item.slice(0, 60)}" is not one of the Critic's estimated items`);
  else if (Math.abs(h - m.critic_hours) > 1e-6) issues.push(`"${m.item.slice(0, 40)}": critic_hours ${m.critic_hours} vs Critic's ${h}`);
  hours += h ?? m.critic_hours;
}
if (hours > MUST_HOURS_BUDGET) issues.push(`adopted must list is ${hours}h > ${MUST_HOURS_BUDGET}h`);
const others = [...verdicts.keys()].filter((t) => t !== pick);
for (const t of others) if (!out.rejected.some((r: any) => r.working_title === t)) issues.push(`no rejection reason for "${t}"`);
const logged = readLedger().filter((e) => e.kind === "decision" && e.run_id === run.run_id);
if (!logged.some((e: any) => e.topic === "greenlight.pick")) issues.push("no greenlight.pick decision in the ledger for this run");

const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns, spent_usd: run.spent_micro_usd / 1e6,
  pick, pick_verdict: verdicts.get(pick), adopted_must_hours: Math.round(hours * 10) / 10, deferred: out.pick.deferred.length,
  art_and_qa: out.pick.art_and_qa?.length ?? 0, ledger_entries: logged.length, pass: issues.length === 0, issues,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nWHY: ${out.pick.why}\n`);
for (const m of out.pick.adopted_must) console.log(`  must  ${m.critic_hours}h  ${m.item}`);
for (const d of out.pick.deferred) console.log(`  defer ${d}`);
for (const c of out.pick.conditions) console.log(`  cond  ${c}`);
for (const a of out.pick.art_and_qa ?? []) console.log(`  art/qa ${a}`);
for (const r of out.rejected) console.log(`  NOT ${r.working_title}: ${r.why_not}`);
