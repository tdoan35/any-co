// Greenlight hand-offs between agents, as task text, plus code-computed Critic verdicts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { verdict, type Verdict } from "./feasibility.ts";

const RUNS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "runs");
const readRun = (id: string) => ({
  run: JSON.parse(readFileSync(path.join(RUNS, id, "run.json"), "utf8")),
  out: JSON.parse(readFileSync(path.join(RUNS, id, "output.json"), "utf8")),
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
