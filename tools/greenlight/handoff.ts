// Greenlight hand-offs between agents, as task text, plus code-computed Critic verdicts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { MUST_HOURS_BUDGET, verdict, type Verdict } from "./feasibility.ts";

export const RUNS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "runs");
const readRun = (id: string, runsRoot: string = RUNS) => ({
  run: JSON.parse(readFileSync(path.join(runsRoot, id, "run.json"), "utf8")),
  out: JSON.parse(readFileSync(path.join(runsRoot, id, "output.json"), "utf8")),
});

export interface Judged extends Partial<Verdict> {
  title: string;
  gap?: string;
  director_must_hours?: number;
  attacks: Array<{ severity: string; target: string; claim: string; fix: string }>;
  must_estimates: Array<{ item: string; hours: number }>;
  strongest?: string;
  issues: string[];
}

const mustItem = (m: any): string => (typeof m === "string" ? m : m.item);

/** Does a path like "scope.must[2]" or "animation_budget" exist in the pitch? */
export function resolves(obj: any, target: string): boolean {
  let cur = obj;
  for (const part of target.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur == null || !(part in Object(cur))) return false;
    cur = cur[part];
  }
  return true;
}

export function criticTask(pitches: any[], notes?: string): string {
  return [
    "Greenlight: review these three pitches for buildability. Attack each one; estimate the must list; score it.",
    "",
    ...pitches.flatMap((p, i) => [`## Pitch ${i + 1}: ${p.working_title}`, "```json", JSON.stringify(p, null, 2), "```", ""]),
    ...(notes ? [`Director's notes: ${notes}`] : []),
  ].join("\n");
}

export function pitchesFromTask(task: string): any[] {
  return [...task.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
}

/** The Critic's review → per-pitch verdicts (tools/greenlight/feasibility.ts) and format checks. */
export function judge(pitches: any[], review: { reviews: any[] }): Judged[] {
  const byTitle = new Map(pitches.map((p) => [p.working_title, p]));
  return review.reviews.map((r) => {
    const issues: string[] = [];
    const p = byTitle.get(r.working_title);
    const base = { title: r.working_title, attacks: r.attacks, must_estimates: r.must_hours, strongest: r.strongest_point };
    if (!p) return { ...base, issues: [`"${r.working_title}" is not a pitch in the task`] };
    const estimated = new Set(r.must_hours.map((m: any) => m.item.trim()));
    for (const m of p.scope.must) if (!estimated.has(mustItem(m).trim())) issues.push(`no hour estimate for must "${mustItem(m).slice(0, 60)}"`);
    for (const a of r.attacks) if (!resolves(p, a.target)) issues.push(`attack target "${a.target}" is not a field of the pitch`);
    const v = verdict({
      scores: Object.fromEntries(Object.entries(r.scores).map(([k, s]: any) => [k, s.score])) as any,
      attacks: r.attacks,
      must_hours: r.must_hours.map((m: any) => m.hours),
      animation: p.animation_budget,
    });
    const own = p.scope.must.reduce((s: number, m: any) => s + (typeof m === "string" ? 0 : m.hours), 0);
    return { ...base, gap: p.gap_label, director_must_hours: own, ...v, issues };
  });
}

/** Task for the Director's revision round: the original brief, its pitches, and the verdicts. */
export function reviseTask(originalTask: string, pitches: any[], judged: Judged[], round: number): string {
  const lines = [
    `Greenlight revision round ${round}: the Feasibility Critic reviewed your pitches. Verdicts are computed in code`,
    "from the Critic's scores, hour estimates, and attacks. Revise all three (see Revision mode).",
    "",
    "# Critic's review",
    "",
  ];
  for (const j of judged) {
    lines.push(`## ${j.title}: ${String(j.verdict).toUpperCase()} (feasibility ${j.score}; must list ${j.must_hours}h by the Critic vs your ${j.director_must_hours}h; ${j.animation_frames} animation frames)`);
    if (j.reasons?.length) lines.push(`Because: ${j.reasons.join("; ")}`);
    lines.push("Critic's hour estimates:", ...j.must_estimates.map((m) => `- ${m.item}: ${m.hours}h`));
    lines.push("Attacks:", ...j.attacks.map((a) => `- [${a.severity}] ${a.target}: ${a.claim} Fix: ${a.fix}`));
    if (j.strongest) lines.push(`Strongest point: ${j.strongest}`);
    lines.push("");
  }
  lines.push("# Your current pitches", "", "```json", JSON.stringify(pitches, null, 2), "```", "", "# Original brief", "", originalTask);
  return lines.join("\n");
}

export const survivors = (judged: Judged[]) => judged.filter((j) => j.verdict && j.verdict !== "veto");

/** Task for the Greenlight Chair: the final round's pitches, verdicts, and Critic estimates, plus the brief. */
export function pickTask(loopDir: string): string {
  const loop = JSON.parse(readFileSync(path.join(loopDir, "loop.json"), "utf8"));
  const last = loop.rounds[loop.rounds.length - 1];
  const d = readRun(last.director_run), c = readRun(last.critic_run);
  const judged = judge(d.out.pitches, c.out);
  const lines = [
    "Greenlight pick: choose the game from the surviving pitches below, commit to a must list, and log the decision.",
    `Refs: director run ${last.director_run}, critic run ${last.critic_run}, loop ${path.basename(loopDir)}.`,
    "",
    "# Verdicts (computed in code)",
    "",
  ];
  for (const j of judged) {
    lines.push(`## ${j.title}: ${String(j.verdict).toUpperCase()} (feasibility ${j.score}; must list ${j.must_hours}h by the Critic; ${j.animation_frames} animation frames)`);
    if (j.reasons?.length) lines.push(`Because: ${j.reasons.join("; ")}`);
    lines.push("Critic's hour estimates:", ...j.must_estimates.map((m) => `- ${m.item}: ${m.hours}h`));
    lines.push("Attacks:", ...j.attacks.map((a) => `- [${a.severity}] ${a.target}: ${a.claim} Fix: ${a.fix}`));
    if (j.strongest) lines.push(`Strongest point: ${j.strongest}`);
    lines.push("");
  }
  lines.push("# Pitches", "", "```json", JSON.stringify(d.out.pitches, null, 2), "```", "", "# Original brief", "", readFileSync(loop.brief, "utf8"));
  return lines.join("\n");
}

/** Task for the Game Director's design-doc mode: everything docs/design.md must answer to. */
export function designTask(chairDir: string, runsRoot: string = RUNS): string {
  const chairAbs = path.resolve(runsRoot, chairDir);
  const chair = readRun(path.basename(chairAbs), path.dirname(chairAbs));
  // pickTask wrote "Refs: ... loop <name>." into the Chair's task; the loop holds the pitches.
  const loopName = String(chair.run.task).match(/\bloop (greenlight-[A-Za-z0-9_-]+)/)?.[1];
  if (!loopName) throw new Error(`no loop ref in the Chair run's task; expected "Refs: ... loop greenlight-..."`);
  const loopDir = path.join(runsRoot, loopName);
  const loop = JSON.parse(readFileSync(path.join(loopDir, "loop.json"), "utf8"));
  const last = loop.rounds[loop.rounds.length - 1];
  const director = readRun(last.director_run, runsRoot);
  const pick = chair.out.pick;
  const pitch = director.out.pitches.find((p: { working_title: string }) => p.working_title === pick.working_title);
  if (!pitch) throw new Error(`pick "${pick.working_title}" is not among the final-round pitches in ${last.director_run}`);
  // The Player Voice findings the pitch addressed: full sized lines from the brief. Wants are
  // copied statements, so the brief line starts with the want; punctuation may drift, and some
  // wants are shortened paraphrases of the brief line, so fall back to a normalized prefix match.
  const briefPath = path.resolve(runsRoot, "..", String(loop.brief));
  const briefLines = readFileSync(briefPath, "utf8").split("\n");
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const briefWantLines = briefLines.filter((l) => /^- .+ \(\d+% of /.test(l));
  const findings = (pitch.wants_addressed as Array<{ want: string }>).map((w) => {
    const exact = briefWantLines.find((l) => l.startsWith(`- ${w.want} (`)) ?? briefWantLines.find((l) => norm(l).startsWith(norm(w.want)));
    return exact ?? `- ${w.want} (sizing not found in the brief)`;
  });
  return [
    "Design doc: the Greenlight Chair picked the game. Write `docs/design.md` in your game-repo clone",
    "(game_clone → game_write → git commit on your agent branch), log the design.scope decision, and",
    "submit the manifest. The doc's section names and the hard rules are in your instructions.",
    `Refs: chair run ${path.basename(path.resolve(chairDir))}, loop ${loopName}, director run ${last.director_run}, brief ${loop.brief}.`,
    "",
    "# The Chair's decision (verbatim)",
    "",
    "- Pick: " + pick.working_title,
    "- Why: " + pick.why,
    ...pick.art_and_qa.map((a: string) => `- Art/QA: ${a}`),
    ...(chair.out.risks_to_watch ?? []).map((r: string) => `- Risk to watch: ${r}`),
    "",
    "```json",
    JSON.stringify({ ...pick, ...(chair.out.risks_to_watch ? { risks_to_watch: chair.out.risks_to_watch } : {}) }, null, 2),
    "```",
    "",
    "# The chosen pitch (final round)",
    "",
    "```json",
    JSON.stringify(pitch, null, 2),
    "```",
    "",
    "# Player Voice findings this pitch addressed (sized, from the brief)",
    "",
    ...findings,
    "",
    "# Hard rules (checked in code by the eval)",
    "",
    `- The Must table is exactly the Chair's adopted_must items and hours (${pick.adopted_must.reduce((s: number, m: { critic_hours: number }) => s + m.critic_hours, 0)}h total, at most ${MUST_HOURS_BUDGET}h).`,
    "- The Should table holds the Chair's deferred items; the Could table is yours to propose.",
    "- The Conditions section copies the Chair's conditions verbatim.",
    "- Nothing the Chair rejected comes back; rejected titles belong in Out of scope only as negatives.",
    "",
  ].join("\n");
}
