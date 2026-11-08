import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uiLint, type UiElement } from "./ui-lint.ts";
import { validateValue } from "./invariants.ts";

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "contracts", "state.schema.json"), "utf8"),
) as { properties: Record<string, unknown> };

const el = (over: Partial<UiElement> & { id: string }): UiElement => ({
  rect: [0, 0, 10, 10],
  z: 1,
  visible: true,
  ...over,
});

const dump = (ui: unknown, tick = 5): unknown => ({
  schema_version: 1,
  scene: "run",
  tick,
  run: { started: true, over: false, seed: 1, elapsed_ticks: tick },
  player: { x: 0, y: 0 },
  resources: {},
  entities: [],
  errors: [],
  ...(Array.isArray(ui) ? { ui } : {}),
});

const findingsOf = (r: ReturnType<typeof uiLint>, check: string) => r.findings.filter((f) => check === f.check);

test("overlap: two visible non-overlay elements intersecting => finding with both ids and tick", () => {
  const r = uiLint([dump([el({ id: "a", rect: [10, 10, 50, 20] }), el({ id: "b", rect: [30, 15, 50, 20], z: 2 })])]);
  const f = findingsOf(r, "overlap");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.ids, ["a", "b"]);
  assert.equal(f[0]!.tick, 5);
  assert.equal(f[0]!.detail, "overlap area 450px²");
});

test("overlap: no false positive for disjoint, parent/child, contains, and overlay elements", () => {
  const ui = [
    el({ id: "hud", rect: [0, 0, 100, 100] }),
    el({ id: "hp", rect: [10, 10, 20, 10], parent: "hud" }), // nested in parent
    el({ id: "mp", rect: [40, 40, 20, 10], parent: "hud", contains: ["xpy"] }), // declared child of hud
    el({ id: "xpy", rect: [45, 42, 5, 5] }),
    el({ id: "tip", rect: [12, 12, 60, 30], overlay: true, z: 9 }), // overlay may cover anything
    el({ id: "far", rect: [500, 400, 20, 10] }),
  ];
  assert.deepEqual(findingsOf(uiLint([dump(ui)]), "overlap"), []);
});

test("offscreen: rect outside the viewport flagged, inside clean; viewport configurable", () => {
  const ui = [el({ id: "ok", rect: [100, 100, 50, 20] }), el({ id: "clip", rect: [1270, 700, 40, 40] })];
  const off = findingsOf(uiLint([dump(ui)]), "offscreen"); // default 1280x720
  assert.deepEqual(off.map((f) => f.ids[0]), ["clip"]);
  assert.match(off[0]!.detail, /1270, 700, 40, 40.*1280x720/);
  assert.deepEqual(findingsOf(uiLint([dump(ui)], { viewport: [2000, 1000] }), "offscreen"), []);
  assert.equal(findingsOf(uiLint([dump([el({ id: "neg", rect: [-5, 0, 10, 10] })])]), "offscreen").length, 1);
});

test("text_px: below the minimum flagged; minimum configurable; invisible and textless exempt", () => {
  const ui = [
    el({ id: "small", rect: [0, 0, 10, 10], text_px: 8 }),
    el({ id: "ok", rect: [40, 0, 10, 10], text_px: 10 }),
    el({ id: "hidden", rect: [80, 0, 10, 10], visible: false, text_px: 2 }),
    el({ id: "notext", rect: [120, 0, 10, 10] }),
  ];
  assert.equal(findingsOf(uiLint([dump(ui)]), "text_px").length, 1);
  const strict = uiLint([dump(ui)], { minTextPx: 12 });
  assert.deepEqual(
    findingsOf(strict, "text_px").map((f) => f.ids[0]).sort(),
    ["ok", "small"],
  );
});

test("grid: off-grid x/y flagged when gridPx set; absent without it", () => {
  const ui = [el({ id: "a", rect: [8, 16, 10, 10] }), el({ id: "b", rect: [10, 15, 10, 10] })];
  assert.deepEqual(findingsOf(uiLint([dump(ui)], { gridPx: 8 }), "grid").map((f) => f.ids[0]), ["b"]);
  assert.deepEqual(findingsOf(uiLint([dump(ui)]), "grid"), []);
});

test("invisible elements are excluded from every check", () => {
  const ui = [
    el({ id: "hiddenOverlap", rect: [0, 0, 100, 100], visible: false }),
    el({ id: "visible", rect: [200, 200, 10, 10] }),
    el({ id: "hiddenOff", rect: [-50, -50, 10, 10], visible: false }),
    el({ id: "hiddenSmall", rect: [300, 300, 10, 10], visible: false, text_px: 1 }),
  ];
  assert.deepEqual(uiLint([dump(ui)]).findings, []);
});

test("absent ui[] => not-implemented, zero dumps checked", () => {
  const r = uiLint([dump(undefined)]);
  assert.equal(r.status, "not-implemented");
  assert.equal(r.findings.length, 0);
  assert.equal(r.dumpsChecked, 0);
});

test("findings accumulate across dumps with each dump's tick", () => {
  const dumps = [
    dump([el({ id: "a", rect: [0, 0, 10, 10] }), el({ id: "b", rect: [5, 5, 10, 10] })], 3), // overlap
    dump([el({ id: "c", rect: [-1, 0, 5, 5] })], 9), // offscreen
  ];
  const r = uiLint(dumps);
  assert.equal(r.dumpsChecked, 2);
  assert.equal(findingsOf(r, "overlap")[0]!.tick, 3);
  assert.equal(findingsOf(r, "offscreen")[0]!.tick, 9);
});

test("malformed ui entries are skipped, not fatal", () => {
  const r = uiLint([dump(["nope", { id: "good", rect: [0, 0, 5, 5], z: 1, visible: true }, { id: "noz", rect: [1, 1, 1, 1], visible: true }])]);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.findings, []);
});

const uiArraySchema = SCHEMA.properties["ui"];
const uiItemSchema = (uiArraySchema as { items: unknown })["items"];

test("schema: ui[] items require id/rect(4)/z/visible; extras rejected; rect numbers >= 0", () => {
  assert.deepEqual(validateValue(uiArraySchema, [], "$"), []);
  assert.ok(validateValue(uiArraySchema, [{}], "$").length > 0); // missing required inside items
  assert.match(validateValue(uiItemSchema, { id: "a", rect: [0, 0, 5], z: 1, visible: true }, "$").join(), /4/);
  assert.match(validateValue(uiItemSchema, { id: "a", rect: [0, 0, 5, 5], z: 1, visible: true, wat: 1 }, "$").join(), /additional/);
  assert.match(validateValue(uiItemSchema, { id: "a", rect: [-1, 0, 5, 5], z: 1, visible: true }, "$").join(), /minimum/);
  assert.match(validateValue(uiItemSchema, { id: "" }, "$").join(), /minLength|string/);
  assert.deepEqual(
    validateValue(uiItemSchema, { id: "a", rect: [0, 0, 5.5, 5], z: 1.5, visible: true, overlay: true, text_px: 12, parent: "p", contains: ["c"] }, "$"),
    [],
  );
});

test("CLI: ui-lint over fixture dirs — findings, not-implemented, exit codes", () => {
  const qaTs = path.join(import.meta.dirname, "qa.ts");
  const run = (dir: string, extra: string[] = []) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", qaTs, "ui-lint", "--dir", dir, ...extra], { timeout: 60_000, encoding: "utf8" });
    return {
      code: r.status,
      parsed: JSON.parse(String(r.stdout)) as { exitCode: number; checks: Array<{ name: string; pass: boolean; detail: string }>; ui?: { status: string } },
    };
  };
  const base = {
    schema_version: 1, scene: "run", tick: 7, run: { started: true, over: false, seed: 1, elapsed_ticks: 7 },
    player: { x: 0, y: 0 }, resources: {}, entities: [], errors: [],
  };

    const bad = mkdtempSync(path.join(tmpdir(), "ui-lint-"));
  writeFileSync(
    path.join(bad, "state.json"),
    JSON.stringify({ ...base, ui: [el({ id: "a", rect: [10, 10, 50, 20], text_px: 12 }), el({ id: "b", rect: [30, 15, 50, 20], z: 2, text_px: 4 })] }),
  );
  const badRun = run(bad);
  assert.equal(badRun.parsed.exitCode, 1, JSON.stringify(badRun.parsed));
  assert.equal(badRun.code, 1);
  assert.deepEqual(badRun.parsed.checks.map((c) => c.name).sort(), ["ui_overlap", "ui_text_px"]);
  assert.equal(badRun.parsed.ui!.status, "ok");

  const none = mkdtempSync(path.join(tmpdir(), "ui-lint-"));
  writeFileSync(path.join(none, "state.json"), JSON.stringify(base));
  const absent = run(none);
  assert.equal(absent.parsed.exitCode, 0);
  assert.deepEqual(absent.parsed.checks.map((c) => c.name), ["ui_lint_not_implemented"]);
  assert.equal(absent.parsed.ui!.status, "not-implemented");

  const clean = mkdtempSync(path.join(tmpdir(), "ui-lint-"));
  writeFileSync(
    path.join(clean, "state.json"),
    JSON.stringify({ ...base, ui: [el({ id: "a", rect: [8, 16, 50, 20], text_px: 12 }), el({ id: "b", rect: [104, 96, 50, 20], z: 2, text_px: 12 })] }),
  );
  const good = run(clean, ["--grid-px", "8"]);
  assert.equal(good.parsed.exitCode, 0, JSON.stringify(good.parsed));
  assert.equal(good.code, 0);
  assert.deepEqual(good.parsed.checks.map((c) => c.name), ["ui_lint"]);
});
