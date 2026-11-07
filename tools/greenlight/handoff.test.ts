import { test } from "node:test";
import assert from "node:assert/strict";
import { criticTask, judge, pitchesFromTask, resolves, reviseTask, survivors } from "./handoff.ts";

const pitch = (title: string, hours: number[], chars = 4, frames = 8) => ({
  working_title: title, gap_label: "G", scope: { must: hours.map((h, i) => ({ item: `m${i}`, hours: h })), should: ["s0"], could: [] },
  animation_budget: { animated_characters: chars, frames_per_character: frames, notes: "" }, hook: "h",
});
const scores = (v: number) => Object.fromEntries(["animation_load", "scope_fit", "systems_complexity", "content_volume", "tech_risk", "ui_complexity"].map((k) => [k, { score: v, why: "x" }]));

test("critic task round-trips pitches", () => {
  const ps = [pitch("A", [2, 3]), pitch("B", [1])];
  assert.deepEqual(pitchesFromTask(criticTask(ps, "n")), ps);
});

test("judge computes verdicts and flags format problems", () => {
  const ps = [pitch("A", [2, 3]), pitch("B", [4])];
  const j = judge(ps, { reviews: [
    { working_title: "A", scores: scores(0.9), must_hours: [{ item: "m0", hours: 2 }, { item: "m1", hours: 4 }], attacks: [{ severity: "minor", target: "scope.should[0]", claim: "c", fix: "f" }], strongest_point: "s" },
    { working_title: "B", scores: scores(0.9), must_hours: [{ item: "m0", hours: 20 }], attacks: [{ severity: "major", target: "should[0]", claim: "c", fix: "f" }], strongest_point: "s" },
  ] });
  assert.deepEqual(j.map((x) => [x.title, x.verdict, x.must_hours, x.director_must_hours]), [["A", "pass", 6, 5], ["B", "veto", 20, 4]]);
  assert.deepEqual(j[1].issues, ['attack target "should[0]" is not a field of the pitch']);
  assert.deepEqual(survivors(j).map((x) => x.title), ["A"]);
  assert.equal(resolves(ps[0], "scope.must[1].hours"), true);
  const t = reviseTask("BRIEF", ps, j, 1);
  assert.match(t, /B: VETO/);
  assert.match(t, /m0: 20h/);
  assert.match(t, /# Original brief\n\nBRIEF$/);
});
