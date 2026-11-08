// Greenlight pitch loop: Director pitches → Critic reviews → (revise → re-review) until enough
// pitches survive or rounds run out. Control flow is code; the agents only judge.
//   node --env-file=.env --import tsx scripts/greenlight-loop.ts --brief runs/<pv-run>/handoff-pitches.md [--rounds 2] [--need 2]
// Writes runs/greenlight-<stamp>/loop.json (every round's verdicts and the run ids) and prints a summary.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAgent } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { RUNS_DIR, runAgent } from "../runner/run.ts";
import { criticTask, judge, reviseTask, survivors, type Judged } from "../tools/greenlight/handoff.ts";

const { values } = parseArgs({ options: { brief: { type: "string" }, rounds: { type: "string", default: "2" }, need: { type: "string", default: "2" } } });
if (!values.brief) throw new Error("usage: greenlight-loop.ts --brief runs/<pv-run>/handoff-pitches.md [--rounds 2] [--need 2]");
const brief = readFileSync(values.brief, "utf8");
const maxRounds = Number(values.rounds), need = Number(values.need);

const naive = naiveClient();
const director = await loadAgent("pitch-writer");
const critic = await loadAgent("feasibility-critic");
const loopDir = path.join(RUNS_DIR, `greenlight-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
mkdirSync(loopDir, { recursive: true });
const log: any = { brief: values.brief, need, rounds: [] as any[] };
const save = () => writeFileSync(path.join(loopDir, "loop.json"), JSON.stringify(log, null, 2));

async function run(spec: typeof director, task: string, label: string) {
  console.log(`\n▶ ${label}`);
  const r = await runAgent(spec, { task, provider: providerFor(spec, naive), naive, log: (l) => console.log("  " + l.slice(0, 150)) });
  console.log(`  ${r.status} in ${r.turns} turns, $${(r.spent_micro_usd / 1e6).toFixed(4)} → ${r.run_id}`);
  if (r.status !== "done") throw new Error(`${label} ended ${r.status}: ${r.error ?? ""}`);
  return r;
}

let task = brief;
let judged: Judged[] = [];
let spent = 0;
for (let round = 0; round <= maxRounds; round++) {
  const d = await run(director, task, round === 0 ? "Director: first pitches" : `Director: revision ${round}`);
  const pitches = (d.output as any).pitches;
  const c = await run(critic, criticTask(pitches, (d.output as any).notes), `Critic: review ${round}`);
  judged = judge(pitches, c.output as any);
  spent += d.spent_micro_usd + c.spent_micro_usd;
  log.rounds.push({ round, director_run: d.run_id, critic_run: c.run_id, verdicts: judged.map(({ title, verdict, score, must_hours, director_must_hours, animation_frames, reasons, issues }) => ({ title, verdict, score, must_hours, director_must_hours, animation_frames, reasons, issues })) });
  save();
  console.log(`  verdicts: ${judged.map((j) => `${j.title} ${j.verdict} (${j.score}, ${j.must_hours}h)`).join(" | ")}`);
  if (survivors(judged).length >= need) break;
  task = reviseTask(brief, pitches, judged, round + 1);
}
log.survivors = survivors(judged).map((j) => j.title);
log.spent_usd = spent / 1e6;
save();
console.log(`\n${log.survivors.length} surviving pitch(es) after ${log.rounds.length} round(s): ${log.survivors.join(", ") || "none"}  ($${log.spent_usd.toFixed(4)})  → ${loopDir}`);
process.exit(log.survivors.length >= need ? 0 : 1);
