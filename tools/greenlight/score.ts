// Greenlight gap score (docs/plan.md §6): demand × (1 − saturation) × feasibility × marketability.
// demand_pct and supply_pct come from tools/catalog (computed in code); feasibility and
// marketability are agent judgments in [0, 1]. The math lives here, never in a prompt.
export interface GapScoreInput {
  demand_pct: number;
  supply_pct: number;
  feasibility: number;
  marketability: number;
}

export function gapScore(g: GapScoreInput): number {
  for (const [k, v] of Object.entries(g)) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${k} must be in [0, 1], got ${v}`);
  }
  return Math.round(g.demand_pct * (1 - g.supply_pct) * g.feasibility * g.marketability * 10_000) / 10_000;
}

/** Sort by score, highest first; ties keep their input order. Returns 1-based ranks. */
export function rankByScore<T>(items: T[], score: (t: T) => number): Array<{ item: T; score: number; rank: number }> {
  return items
    .map((item, i) => ({ item, score: score(item), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ item, score }, k) => ({ item, score, rank: k + 1 }));
}
