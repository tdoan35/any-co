import { test } from "node:test";
import assert from "node:assert/strict";
import { criticTask, findingsSection, judge, parseFindings, pitchesFromTask, resolveWant, resolves, reviseTask, survivors } from "./handoff.ts";

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

const finding = (statement: string, term = "t") => ({ statement, why_it_matters: "w", sized_by: { appid: 1, kind: "negative", term, share: 0.25, count: 25, sample_size: 100 }, quotes: [] });
const seg = (label: string, wants: string[], loves: string[], breakers: string[] = []) => ({
  gap_label: label, games_read: [{ appid: 1, name: "G", negative_read: 20, positive_read: 15 }],
  wants: wants.map((w) => finding(w)), loves: loves.map((l) => finding(l)), deal_breakers: breakers.map((d) => finding(d)), attention: { summary: "flat", ratios: [] },
});
const pv = { segments: [
  seg("Gap A", ["Players want X: 25% say so, with detail", "Players want Y"], ["They love Z"], ["Saves get wiped"]),
  seg("Gap B", ["Players want (bracketed) Q"], ["They love R"]),
], cross_segment: ["c"] };

test("findings are numbered across segments by kind and parse back", () => {
  const lines = findingsSection(pv);
  assert.ok(lines.includes('- [W1] Players want X: 25% say so, with detail (25% of 100 negative reviews of appid 1 mention "t") — w'));
  const fs = parseFindings(["# Player findings", "", ...lines].join("\n"));
  assert.deepEqual(fs.map((f) => [f.id, f.kind, f.statement]), [
    ["W1", "want", "Players want X: 25% say so, with detail"], ["W2", "want", "Players want Y"], ["L1", "love", "They love Z"],
    ["D1", "deal_breaker", "Saves get wiped"], ["W3", "want", "Players want (bracketed) Q"], ["L2", "love", "They love R"],
  ]);
});

test("a want resolves by id or by its whole statement; wrong ids and shortened copies fail", () => {
  const fs = parseFindings(findingsSection(pv).join("\n"));
  const ok = (w: string) => { const r = resolveWant(w, fs); assert.notEqual(typeof r, "string", String(r)); return (r as any).id; };
  assert.equal(ok("W3"), "W3");
  assert.equal(ok(" D1 "), "D1");
  assert.equal(ok("Players want X: 25% say so, with detail"), "W1");
  assert.equal(resolveWant("W9", fs), "want id W9 is not a finding in the task");
  assert.match(String(resolveWant("Players want X", fs)), /^want not copied from findings/);
  assert.match(String(resolveWant("[W1] Players want X: 25% say so, with detail", fs)), /^want not copied/);
  assert.match(String(resolveWant("w1", fs)), /^want not copied/);
});

test("briefs written before numbering still parse (no ids)", () => {
  const old = ["## Gap", "Wants:", '- Players want Y (25% of 100 negative reviews of appid 1 mention "t") — w', "Loves:", '- They love Z (9% of 80 positive reviews of appid 1 mention "u") — w'].join("\n");
  assert.deepEqual(parseFindings(old).map((f) => [f.id, f.kind, f.statement]), [[null, "want", "Players want Y"], [null, "love", "They love Z"]]);
  assert.equal(resolveWant("W1", parseFindings(old)), "want id W1 is not a finding in the task");
});
