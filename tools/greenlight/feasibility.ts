// Feasibility verdicts for Greenlight pitches. The Critic judges sub-scores and writes attacks;
// this code turns them into a score and a verdict, so the veto rule is fixed and auditable.

export const WEIGHTS = {
  animation_load: 0.25,
  scope_fit: 0.25,
  systems_complexity: 0.15,
  content_volume: 0.15,
  tech_risk: 0.1,
  ui_complexity: 0.1,
} as const;
export type SubScore = keyof typeof WEIGHTS;

// Animation gate on the pitch's own declared budget (characters × frames).
export const ANIMATION_FRAMES_MAJOR = 160;
export const ANIMATION_FRAMES_BLOCKER = 320;
// One-day build: engineering hours available for the `must` list.
export const MUST_HOURS_BUDGET = 10;
export const VETO_BELOW = 0.4;
export const CUTS_BELOW = 0.65;

export type Severity = "blocker" | "major" | "minor";
export interface Verdict {
  score: number;
  verdict: "veto" | "pass_with_cuts" | "pass";
  reasons: string[];
  animation_frames: number;
  must_hours: number;
}

export function feasibilityScore(scores: Record<SubScore, number>): number {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as [SubScore, number][]) {
    const v = scores[k];
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${k} must be in [0, 1], got ${v}`);
    s += w * v;
  }
  return Math.round(s * 1000) / 1000;
}

export function verdict(input: {
  scores: Record<SubScore, number>;
  attacks: Array<{ severity: Severity }>;
  must_hours: number[];
  animation: { animated_characters: number; frames_per_character: number };
}): Verdict {
  const score = feasibilityScore(input.scores);
  const frames = input.animation.animated_characters * input.animation.frames_per_character;
  const hours = Math.round(input.must_hours.reduce((a, b) => a + b, 0) * 10) / 10;
  const reasons: string[] = [];
  const blockers = input.attacks.filter((a) => a.severity === "blocker").length;
  const majors = input.attacks.filter((a) => a.severity === "major").length;
  let v: Verdict["verdict"] = "pass";
  const worsen = (to: Verdict["verdict"], why: string) => {
    reasons.push(why);
    if (to === "veto" || (to === "pass_with_cuts" && v === "pass")) v = to;
  };
  if (blockers) worsen("veto", `${blockers} blocker attack(s)`);
  if (score < VETO_BELOW) worsen("veto", `feasibility ${score} < ${VETO_BELOW}`);
  if (frames > ANIMATION_FRAMES_BLOCKER) worsen("veto", `${frames} animation frames > ${ANIMATION_FRAMES_BLOCKER}`);
  else if (frames > ANIMATION_FRAMES_MAJOR) worsen("pass_with_cuts", `${frames} animation frames > ${ANIMATION_FRAMES_MAJOR}`);
  if (hours > MUST_HOURS_BUDGET * 1.5) worsen("veto", `must list ${hours}h > ${MUST_HOURS_BUDGET * 1.5}h`);
  else if (hours > MUST_HOURS_BUDGET) worsen("pass_with_cuts", `must list ${hours}h > ${MUST_HOURS_BUDGET}h`);
  if (majors) worsen("pass_with_cuts", `${majors} major attack(s)`);
  if (score < CUTS_BELOW) worsen("pass_with_cuts", `feasibility ${score} < ${CUTS_BELOW}`);
  return { score, verdict: v, reasons, animation_frames: frames, must_hours: hours };
}
