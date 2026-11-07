// Greenlight hand-offs, as task files built from earlier runs' outputs.
//   node --import tsx scripts/greenlight-handoff.ts runs/<market-analyst-run> [--top 3]
//     → runs/<ma-run>/handoff-player-voice.md  (task for the Player Voice Analyst)
//   node --import tsx scripts/greenlight-handoff.ts runs/<market-analyst-run> --voice runs/<player-voice-run> [--top 3]
//     → runs/<pv-run>/handoff-pitches.md       (task for the Game Director)
//   node --import tsx scripts/greenlight-handoff.ts --pitches runs/<game-director-run>
//     → runs/<gd-run>/handoff-critic.md        (task for the Feasibility Critic)
//   node --import tsx scripts/greenlight-handoff.ts --pick runs/greenlight-<stamp>
//     → runs/greenlight-<stamp>/handoff-pick.md (task for the Greenlight Chair)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { criticTask, pickTask } from "../tools/greenlight/handoff.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: "string", default: "3" }, voice: { type: "string" }, pitches: { type: "string" }, pick: { type: "string" } } });
if (values.pick) {
  const file = path.join(values.pick, "handoff-pick.md");
  writeFileSync(file, pickTask(values.pick));
  console.log(file);
  process.exit(0);
}
if (values.pitches) {
  const gd = JSON.parse(readFileSync(path.join(values.pitches, "output.json"), "utf8"));
  const file = path.join(values.pitches, "handoff-critic.md");
  writeFileSync(file, criticTask(gd.pitches, gd.notes));
  console.log(file);
  process.exit(0);
}
const dir = positionals[0];
if (!dir) throw new Error("usage: greenlight-handoff.ts runs/<market-analyst-run> [--top 3]");
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const gaps = out.gaps.slice(0, Number(values.top));
const lines = [
  "The Market Analyst found these market gaps. For each one, read what players of its comparable games",
  "say, and report their unmet wants, loves, and deal-breakers.",
  "",
];
gaps.forEach((g: any, i: number) => {
  lines.push(`## ${i + 1}. ${g.label}`);
  lines.push(`Tags: ${g.tags.join(", ")}`);
  lines.push(`Thesis: ${g.thesis}`);
  lines.push("Comparables:");
  for (const c of g.comparables) lines.push(`- ${c.name} (appid ${c.appid}, ${c.reviews_total} reviews)`);
  lines.push("");
});
if (!values.voice) {
  const file = path.join(dir, "handoff-player-voice.md");
  writeFileSync(file, lines.join("\n"));
  console.log(file);
} else {
  const pv = JSON.parse(readFileSync(path.join(values.voice, "output.json"), "utf8"));
  const out2 = [
    "Greenlight: write three pitches from these market gaps and player findings.",
    "",
    "# Market gaps (from the Market Analyst)",
    "",
    ...lines.slice(3),
    "# Player findings (from the Player Voice Analyst)",
    "",
  ];
  const fmt = (f: any) => `- ${f.statement} (${Math.round(f.sized_by.share * 100)}% of ${f.sized_by.sample_size} ${f.sized_by.kind} reviews of appid ${f.sized_by.appid} mention "${f.sized_by.term}") — ${f.why_it_matters}`;
  for (const seg of pv.segments) {
    out2.push(`## ${seg.gap_label}`, `Read: ${seg.games_read.map((g: any) => g.name).join(", ")}`, "Wants:", ...seg.wants.map(fmt), "Loves:", ...seg.loves.map(fmt));
    if (seg.deal_breakers.length) out2.push("Deal-breakers:", ...seg.deal_breakers.map(fmt));
    out2.push(`Attention: ${seg.attention.summary}`, "");
  }
  if (pv.cross_segment?.length) out2.push("## Across segments", ...pv.cross_segment.map((c: string) => `- ${c}`), "");
  const file = path.join(values.voice, "handoff-pitches.md");
  writeFileSync(file, out2.join("\n"));
  console.log(file);
}
