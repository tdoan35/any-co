// Mechanical eval of a Game Director design-doc run. Usage: npm run eval:game-director-design -- runs/<run_id>
// Opens the run's game clone at the reported commit and checks docs/design.md against the
// Chair's pick (embedded in the task by designTask) and the run's manifest output.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkDesignDoc, REQUIRED_SECTIONS, docAtCommit, sectionText, type ChairPick, type DesignManifest } from "../tools/greenlight/design.ts";
import { read as readLedger, type DecisionEntry } from "../tools/ledger/ledger.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) {
  console.error("usage: npm run eval:game-director-design -- runs/<run_id>");
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
if (!existsSync(path.join(dir, "output.json"))) {
  console.log(`run ${run.status}: no output${run.error ? ` (${String(run.error).split("\n")[0]})` : ""}`);
  process.exit(1);
}
const out: DesignManifest = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const task = String(run.task);

// designTask embeds the Chair's pick as the task's first ```json block.
const block = task.match(/```json\n([\s\S]*?)\n```/);
if (!block) {
  console.log(JSON.stringify({ run_id: run.run_id, pass: false, issues: ["task has no Chair-pick JSON block; build it with greenlight-handoff.ts --design"] }, null, 2));
  process.exit(1);
}
const pick: ChairPick = JSON.parse(block[1]);

let checks = 0, ok = 0;
const issues: string[] = [];
const check = (cond: boolean, msg: string) => { checks++; if (cond) ok++; else issues.push(msg); };

check(out.branch === "agent/game-director-design", `branch "${out.branch}" is not the agent branch game_clone creates`);
check(out.doc_path === "docs/design.md", `doc_path "${out.doc_path}" is not docs/design.md`);

const clone = path.join(dir, "workspace", "game");
let doc = "";
if (!existsSync(clone)) {
  issues.push("no game clone at workspace/game; run game_clone in the run");
  checks++;
} else {
  const at = docAtCommit(clone, String(out.commit ?? ""), String(out.doc_path ?? "docs/design.md"));
  check(at.doc !== undefined, `cannot read the doc at commit ${out.commit} in the clone: ${at.error}`);
  doc = at.doc ?? "";
}

if (doc) {
  for (const issue of checkDesignDoc(doc, pick, out)) { checks++; issues.push(issue); }
  const adopted = pick.adopted_must ?? [];
  check((out.must ?? []).length === adopted.length && adopted.every((a, i) => out.must?.[i]?.item === a.item && Math.abs((out.must?.[i]?.hours ?? -1) - a.critic_hours) < 1e-6),
    "manifest must[] does not copy the Chair's adopted_must exactly");
  check((out.data_files ?? []).length >= 1, "manifest declares no data files");
}

const logged = readLedger().filter((e): e is DecisionEntry => e.kind === "decision" && e.run_id === run.run_id);
check(logged.some((e) => e.topic === "design.scope"), "no design.scope decision in the ledger for this run");

const sectionsPresent = doc ? REQUIRED_SECTIONS.filter((s) => sectionText(doc, s) !== "" || new RegExp(`^## ${s}\\s*$`, "m").test(doc)) : [];
const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns, spent_usd: run.spent_micro_usd / 1e6,
  checks_passed: `${ok}/${checks}`, sections: `${sectionsPresent.length}/${REQUIRED_SECTIONS.length}`,
  commit: out.commit, branch: out.branch, data_files: out.data_files?.map((f) => f.path) ?? [],
  ledger_topic: "design.scope", pass: issues.length === 0, issues,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (doc) {
  console.log(`\nDOC ${out.doc_path} @ ${out.commit} on ${out.branch}`);
  for (const m of out.must ?? []) console.log(`  must  ${m.hours}h  ${m.item}`);
  console.log(`  tiers should=${out.should_count} could=${out.could_count}`);
  for (const f of out.data_files ?? []) console.log(`  data  ${f.path} — ${f.what ?? ""}`);
}
