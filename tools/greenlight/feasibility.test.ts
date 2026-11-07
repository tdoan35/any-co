import { test } from "node:test";
import assert from "node:assert/strict";
import { feasibilityScore, verdict } from "./feasibility.ts";

const good = { animation_load: 0.9, scope_fit: 0.8, systems_complexity: 0.8, content_volume: 0.8, tech_risk: 0.9, ui_complexity: 0.8 };
const anim = { animated_characters: 4, frames_per_character: 8 };

test("weighted score", () => {
  assert.equal(feasibilityScore(good), 0.835);
  assert.throws(() => feasibilityScore({ ...good, tech_risk: 2 }), /tech_risk/);
});

test("verdicts: pass, cuts, veto", () => {
  assert.equal(verdict({ scores: good, attacks: [{ severity: "minor" }], must_hours: [2, 3], animation: anim }).verdict, "pass");
  assert.equal(verdict({ scores: good, attacks: [{ severity: "major" }], must_hours: [2, 3], animation: anim }).verdict, "pass_with_cuts");
  assert.equal(verdict({ scores: good, attacks: [{ severity: "blocker" }, { severity: "major" }], must_hours: [2], animation: anim }).verdict, "veto");
  const lowScore = verdict({ scores: { ...good, animation_load: 0, scope_fit: 0, systems_complexity: 0.2 }, attacks: [], must_hours: [2], animation: anim });
  assert.equal(lowScore.verdict, "veto");
  const frames = verdict({ scores: good, attacks: [], must_hours: [2], animation: { animated_characters: 12, frames_per_character: 16 } });
  assert.deepEqual([frames.verdict, frames.animation_frames], ["pass_with_cuts", 192]);
  const hours = verdict({ scores: good, attacks: [], must_hours: [6, 6, 6], animation: anim });
  assert.deepEqual([hours.verdict, hours.must_hours], ["veto", 18]);
});
