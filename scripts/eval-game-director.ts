// Mechanical eval of a Game Director pitch run. Usage: npm run eval:game-director -- runs/<run_id>
// Wants are checked against the Player Voice findings in the task (handoff-pitches.md): each is a
// finding id that exists there ("W3"), or a whole statement copied exactly. Shortened copies fail.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCatalog } from "../runner/tools/impl.ts";
import { parseFindings, resolveWant } from "../tools/greenlight/handoff.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) {
  console.error("usage: npm run eval:game-director -- runs/<run_id>");
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
if (!existsSync(path.join(dir, "output.json"))) {
  console.log(`run ${run.status}: no output${run.error ? ` (${String(run.error).split("\n")[0]})` : ""}`);
  process.exit(1);
}
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const task = String(run.task);
const gapLabels = new Set([...task.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1].trim()));
const findings = parseFindings(task);
const simplify = (s: string) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const pitches: any[] = [];
let checks = 0, ok = 0;
const check = (cond: boolean, issues: string[], msg: string) => { checks++; if (cond) ok++; else issues.push(msg); };
for (const p of out.pitches) {
  const issues: string[] = [];
  check(gapLabels.has(p.gap_label), issues, `gap_label "${p.gap_label}" is not a gap in the task`);
  const wants: string[] = [];
  for (const w of p.wants_addressed) {
    const hit = resolveWant(w.want, findings);
    check(typeof hit !== "string", issues, typeof hit === "string" ? hit : "");
    if (typeof hit !== "string") wants.push(`${hit.id ?? "-"} ${hit.statement}`);
  }
  for (const c of p.comparables) {
    const g = JSON.parse((await runCatalog(["game", "--appid", String(c.appid)])).content);
    check(!g.error && simplify(g.name).includes(simplify(c.name).slice(0, 12)), issues, `comparable ${c.appid} "${c.name}" ${g.error ? "not in catalog" : `is "${g.name}"`}`);
  }
  const anim = p.animation_budget.animated_characters * p.animation_budget.frames_per_character;
  const hours = p.scope.must.reduce((s: number, m: any) => s + (m.hours ?? 0), 0);
  pitches.push({ title: p.working_title, gap: p.gap_label, logline: p.logline, hook: p.hook, must: p.scope.must.length, must_hours: hours, animation_frames: anim, price: p.price_usd, wants, changes: p.changes_from_review ?? [], issues });
}
const gapsCovered = new Set(out.pitches.map((p: any) => p.gap_label)).size;
const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns, spent_usd: run.spent_micro_usd / 1e6,
  checks_passed: `${ok}/${checks}`, gaps_covered: gapsCovered,
  distinct_titles: new Set(out.pitches.map((p: any) => simplify(p.working_title))).size === out.pitches.length,
  pass: ok === checks && gapsCovered >= 2,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify({ summary, pitches }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const p of pitches) {
  console.log(`\n## ${p.title}  [${p.gap}]  $${p.price}, ${p.must} musts (${p.must_hours}h), ${p.animation_frames} animation frames`);
  for (const w of p.wants) console.log(`  want ${w.slice(0, 160)}`);
  for (const c of p.changes) console.log(`  ~ ${c.slice(0, 200)}`);
  console.log(`  ${p.logline}\n  hook: ${p.hook}`);
  for (const i of p.issues) console.log(`  ! ${i}`);
}
