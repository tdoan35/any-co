// Mechanical eval of a Feasibility Critic run, plus the code-computed verdicts.
// Usage: npm run eval:feasibility-critic -- runs/<run_id>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { judge, pitchesFromTask } from "../tools/greenlight/handoff.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) {
  console.error("usage: npm run eval:feasibility-critic -- runs/<run_id>");
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
if (!existsSync(path.join(dir, "output.json"))) {
  console.log(`run ${run.status}: no output${run.error ? ` (${String(run.error).split("\n")[0]})` : ""}`);
  process.exit(1);
}
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const pitches = pitchesFromTask(String(run.task));
const rows = judge(pitches, out);
const checks = rows.reduce((n, r) => n + r.attacks.length + (pitches.find((p) => p.working_title === r.title)?.scope.must.length ?? 1), 0);
const failed = rows.reduce((n, r) => n + r.issues.length, 0);
const ok = checks - failed;
const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns, spent_usd: run.spent_micro_usd / 1e6,
  reviewed: `${out.reviews.length}/${pitches.length}`, checks_passed: `${ok}/${checks}`,
  verdicts: Object.fromEntries(["veto", "pass_with_cuts", "pass"].map((k) => [k, rows.filter((r) => r.verdict === k).length])),
  pass: ok === checks && out.reviews.length === pitches.length,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify({ summary, reviews: rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const r of rows) {
  console.log(`\n## ${r.title}  →  ${String(r.verdict).toUpperCase()}  (feasibility ${r.score}, must ${r.must_hours}h by Critic vs ${r.director_must_hours}h by Director, ${r.animation_frames} frames)`);
  if (r.reasons?.length) console.log(`  because: ${r.reasons.join("; ")}`);
  for (const a of r.attacks) console.log(`  [${a.severity}] ${a.target}: ${a.claim}`.slice(0, 230));
  if (r.strongest) console.log(`  + ${r.strongest}`);
  for (const i of r.issues) console.log(`  ! ${i}`);
}
