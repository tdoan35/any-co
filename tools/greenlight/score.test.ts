import { test } from "node:test";
import assert from "node:assert/strict";
import { gapScore, rankByScore } from "./score.ts";

test("gap score multiplies the four factors", () => {
  assert.equal(gapScore({ demand_pct: 0.9, supply_pct: 0.2, feasibility: 0.5, marketability: 1 }), 0.36);
  assert.equal(gapScore({ demand_pct: 1, supply_pct: 1, feasibility: 1, marketability: 1 }), 0);
  assert.throws(() => gapScore({ demand_pct: 1.2, supply_pct: 0, feasibility: 1, marketability: 1 }), /demand_pct/);
});

test("rank is by score, stable on ties", () => {
  const r = rankByScore(["a", "b", "c"], (x) => ({ a: 0.1, b: 0.5, c: 0.1 })[x]!);
  assert.deepEqual(r.map((x) => [x.item, x.rank]), [["b", 1], ["a", 2], ["c", 3]]);
});
