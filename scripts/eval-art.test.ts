import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "../tools/art/png.ts";
import { runGate } from "../tools/art/gate.ts";
import { evalDirector, parseStyleBible } from "./eval-art-director.ts";
import { evalArtists } from "./eval-artists.ts";

const PALETTE = ["#010203", "#040506"];

function buildRun(agent: string): string {
  // each run gets its own runs/ parent so a spend.jsonl written by one test never leaks into another
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "arteval-runs-")), "run");
  const clone = path.join(dir, "workspace", "game");
  mkdirSync(path.join(clone, "assets", "sprites"), { recursive: true });
  mkdirSync(path.join(clone, "docs"), { recursive: true });
  const img = makeImage(16, 16);
  for (let i = 0; i < 256; i++) img.data.set([1, 2, 3, 255], i * 4);
  writeFileSync(path.join(clone, "assets", "sprites", "player.png"), encodePng(img));
  writeFileSync(
    path.join(clone, "assets", "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      style_bible: "docs/style-bible.md",
      grid: { w: 16, h: 16 },
      palette: PALETTE,
      assets: [{ id: "player", type: "sprite", path: "assets/sprites/player.png", size: { w: 16, h: 16 }, frames: 1, palette: ["#010203"], anchor: null }],
    }),
  );
  writeFileSync(
    path.join(clone, "docs", "style-bible.md"),
    ["# Style bible", "", "- grid: 16x16", `- palette: ${PALETTE.join(", ")}`, "- outline: 1px outer in the darkest color", "- light: top-left", ""].join("\n"),
  );
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: path.basename(dir), agent, status: "done", task: "art" }));
  return dir;
}

function gateNumbers(dir: string) {
  const gate = runGate(path.join(dir, "workspace", "game"));
  const asset = gate.assets[0];
  return {
    pass: asset.pass,
    offPaletteShare: asset.numbers.offPaletteShare ?? 0,
    maxFrameDrift: asset.numbers.frameDrift && asset.numbers.frameDrift.length > 0 ? Math.max(...asset.numbers.frameDrift) : null,
    anchorDrift: asset.numbers.anchorDrift ?? null,
  };
}

test("parseStyleBible finds the four declarations", () => {
  const bible = parseStyleBible("# t\n\n- GRID: 16x16\n- palette: #010203, #040506\n- outline: 1px\n- light: top-left\n- extra: ignored\n");
  assert.equal(bible.grid, "16x16");
  assert.deepEqual(bible.palette, ["#010203", "#040506"]);
  assert.equal(bible.outline, "1px");
  assert.equal(bible.light, "top-left");
});

test("art-director eval passes a truthful run and fails lying numbers", () => {
  const dir = buildRun("art-director");
  const fresh = gateNumbers(dir);
  writeFileSync(
    path.join(dir, "output.json"),
    JSON.stringify({
      style_bible: "docs/style-bible.md",
      manifest: { locked: true, grid: { w: 16, h: 16 }, palette: PALETTE },
      anchors: [{ id: "player", path: "assets/sprites/player.png", frames: 1 }],
      assets: [{ id: "player", path: "assets/sprites/player.png", verdict: "approve", reason: "gate green", ...fresh }],
      regenerations: { calls: 1, spent_usd: 0.18 },
      notes: "",
    }),
  );
  const pass = evalDirector(dir);
  assert.equal(pass.pass, true, JSON.stringify(pass.issues));
  assert.equal(pass.checks_passed.endsWith("/" + pass.checks_passed.split("/")[1]), true);

  // lie: off-palette share understated
  const lying = buildRun("art-director");
  const fresh2 = gateNumbers(lying);
  writeFileSync(
    path.join(lying, "output.json"),
    JSON.stringify({
      style_bible: "docs/style-bible.md",
      manifest: { locked: true, grid: { w: 16, h: 16 }, palette: PALETTE },
      anchors: [],
      assets: [{ id: "player", path: "assets/sprites/player.png", verdict: "approve", reason: "r", ...fresh2, offPaletteShare: 0.5 }],
      regenerations: { calls: 0, spent_usd: 0 },
      notes: "",
    }),
  );
  const fail = evalDirector(lying);
  assert.equal(fail.pass, false);
  assert.ok(fail.issues.some((i) => i.includes("offPaletteShare")), fail.issues.join("; "));
});

test("art-director eval fails a missing bible declaration and a palette mismatch", () => {
  const noLight = buildRun("art-director");
  const bible = path.join(noLight, "workspace", "game", "docs", "style-bible.md");
  writeFileSync(bible, readFileSync(bible, "utf8").replace("- light: top-left", ""));
  const fresh = gateNumbers(noLight);
  writeFileSync(
    path.join(noLight, "output.json"),
    JSON.stringify({
      style_bible: "docs/style-bible.md",
      manifest: { locked: true, grid: { w: 16, h: 16 }, palette: PALETTE },
      anchors: [],
      assets: [{ id: "player", path: "p", verdict: "approve", reason: "r", ...fresh }],
      regenerations: { calls: 0, spent_usd: 0 },
      notes: "",
    }),
  );
  const r1 = evalDirector(noLight);
  assert.equal(r1.pass, false);
  assert.ok(r1.issues.some((i) => i.includes("light")), r1.issues.join("; "));

  const mismatch = buildRun("art-director");
  const fresh2 = gateNumbers(mismatch);
  writeFileSync(
    path.join(mismatch, "output.json"),
    JSON.stringify({
      style_bible: "docs/style-bible.md",
      manifest: { locked: true, grid: { w: 16, h: 16 }, palette: ["#010203", "#0a0b0c"] },
      anchors: [],
      assets: [{ id: "player", path: "p", verdict: "approve", reason: "r", ...fresh2 }],
      regenerations: { calls: 0, spent_usd: 0 },
      notes: "",
    }),
  );
  const r2 = evalDirector(mismatch);
  assert.equal(r2.pass, false);
  assert.ok(r2.issues.some((i) => /reported manifest/.test(i)), r2.issues.join("; "));
});

test("artists eval passes a truthful run and fails a copied-verdict lie", () => {
  const dir = buildRun("sprite-artist");
  const gate = runGate(path.join(dir, "workspace", "game"));
  writeFileSync(
    path.join(dir, "output.json"),
    JSON.stringify({
      generated: [{ id: "player", path: "game/assets/sprites/player.png", provider: "retrodiffusion", frames: 1, in_manifest: true }],
      gate: { ok: gate.ok, failed: gate.assets.filter((a) => !a.pass).map((a) => a.id) },
      postprocess: { snap: true, lock: true, outline: true },
      spent_usd: 0.18,
      notes: "",
    }),
  );
  const pass = evalArtists(dir);
  assert.equal(pass.pass, true, JSON.stringify(pass.issues));

  const lying = buildRun("env-ui-artist");
  writeFileSync(
    path.join(lying, "output.json"),
    JSON.stringify({
      generated: [
        { id: "player", path: "game/assets/sprites/player.png", provider: "pixellab", frames: 1, in_manifest: true },
        { id: "ghost", path: "game/assets/sprites/ghost.png", provider: "pixellab", frames: 1, in_manifest: true },
      ],
      gate: { ok: true, failed: [] },
      postprocess: { snap: true, lock: true, outline: false },
      spent_usd: 0,
      notes: "",
    }),
  );
  const fail = evalArtists(lying);
  assert.equal(fail.pass, false);
  assert.ok(fail.issues.some((i) => i.includes("ghost")), fail.issues.join("; "));
  assert.ok(fail.issues.some((i) => i.includes("spent_usd")), fail.issues.join("; "));
});

// ---- T3-fix 3 regressions: the evals must check the clone, not the agent's claims ----

function directorOutput(dir: string, overrides: Record<string, unknown> = {}) {
  const fresh = gateNumbers(dir);
  return {
    style_bible: "docs/style-bible.md",
    manifest: { locked: true, grid: { w: 16, h: 16 }, palette: PALETTE },
    anchors: [],
    assets: [{ id: "player", path: "assets/sprites/player.png", verdict: "approve", reason: "r", ...fresh }],
    regenerations: { calls: 0, spent_usd: 0 },
    notes: "",
    ...overrides,
  };
}

test("director eval reads the clone's real manifest: palette/grid mismatch with the bible fails even if the report claims a match", () => {
  const dir = buildRun("art-director");
  const manifestPath = path.join(dir, "workspace", "game", "assets", "manifest.json");
  const real = JSON.parse(readFileSync(manifestPath, "utf8"));
  real.palette = ["#010203", "#0a0b0c"]; // differs from the bible
  real.grid = { w: 8, h: 8 }; // differs from the bible's 16x16
  writeFileSync(manifestPath, JSON.stringify(real));
  writeFileSync(path.join(dir, "output.json"), JSON.stringify(directorOutput(dir))); // still reports the bible's palette/grid
  const r = evalDirector(dir);
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => /real manifest palette/i.test(i)), r.issues.join("; "));
  assert.ok(r.issues.some((i) => /real manifest grid/i.test(i)), r.issues.join("; "));
  assert.ok(r.issues.some((i) => /reported manifest/i.test(i)), r.issues.join("; "));
});

test("director eval includes the gate's overall verdict (unlisted files fail the run)", () => {
  const dir = buildRun("art-director");
  writeFileSync(path.join(dir, "workspace", "game", "assets", "sprites", "stray.png"), encodePng(makeImage(16, 16)));
  writeFileSync(path.join(dir, "output.json"), JSON.stringify(directorOutput(dir)));
  const r = evalDirector(dir);
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => /unlisted/i.test(i)), r.issues.join("; "));
});

test("artists eval compares spent_usd with the run's recorded spend", () => {
  const dir = buildRun("sprite-artist");
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: path.basename(dir), agent: "sprite-artist", status: "done", spent_micro_usd: 4_200_000 }));
  const gate = runGate(path.join(dir, "workspace", "game"));
  writeFileSync(
    path.join(dir, "output.json"),
    JSON.stringify({
      generated: [{ id: "player", path: "game/assets/sprites/player.png", provider: "retrodiffusion", frames: 1, in_manifest: true }],
      gate: { ok: gate.ok, failed: gate.assets.filter((a) => !a.pass).map((a) => a.id) },
      postprocess: { snap: true, lock: true, outline: true },
      spent_usd: 0.01, // run says $4.20
      notes: "",
    }),
  );
  const r = evalArtists(dir);
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => /spent_usd/.test(i) && /4\.2/.test(i)), r.issues.join("; "));
});

test("artists eval uses runs/spend.jsonl art_generate charges as the floor for spent_usd", () => {
  const dir = buildRun("env-ui-artist");
  const runId = path.basename(dir);
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: runId, agent: "env-ui-artist", status: "done", spent_micro_usd: 500_000 }));
  writeFileSync(
    path.join(path.dirname(dir), "spend.jsonl"),
    [
      { ts: "t", run_id: runId, agent: "env-ui-artist", kind: "model", what: "z-ai/glm-5.3", micro_usd: 140_000 },
      { ts: "t", run_id: runId, agent: "env-ui-artist", kind: "tool", what: "art_generate", micro_usd: 180_000 },
      { ts: "t", run_id: runId, agent: "env-ui-artist", kind: "tool", what: "art_generate", micro_usd: 180_000 },
      { ts: "t", run_id: "other-run", agent: "x", kind: "tool", what: "art_generate", micro_usd: 9_000_000 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const gate = runGate(path.join(dir, "workspace", "game"));
  const output = (spent: number) =>
    JSON.stringify({
      generated: [{ id: "player", path: "game/assets/sprites/player.png", provider: "retrodiffusion", frames: 1, in_manifest: true }],
      gate: { ok: gate.ok, failed: gate.assets.filter((a) => !a.pass).map((a) => a.id) },
      postprocess: { snap: true, lock: true, outline: false },
      spent_usd: spent,
      notes: "",
    });
  writeFileSync(path.join(dir, "output.json"), output(0.36));
  assert.equal(evalArtists(dir).pass, true, JSON.stringify(evalArtists(dir).issues));
  writeFileSync(path.join(dir, "output.json"), output(0.18)); // under-reports one of two paid calls
  const r = evalArtists(dir);
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => /art_generate tool spend 0\.36/.test(i)), r.issues.join("; "));
});

test("T3-followup 1: a spend.jsonl with no art_generate charge for this run fails generated assets and keeps the half-of-run floor", () => {
  const dir = buildRun("sprite-artist");
  const runId = path.basename(dir);
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: runId, agent: "sprite-artist", status: "done", spent_micro_usd: 4_200_000 }));
  // the ledger holds only another run's entry (also what a stray spend.jsonl looks like)
  writeFileSync(path.join(path.dirname(dir), "spend.jsonl"), JSON.stringify({ ts: "t", run_id: "other-run", kind: "tool", what: "art_generate", micro_usd: 180_000 }) + "\n");
  const gate = runGate(path.join(dir, "workspace", "game"));
  const output = (spent: number) =>
    JSON.stringify({
      generated: [{ id: "player", path: "game/assets/sprites/player.png", provider: "retrodiffusion", frames: 1, in_manifest: true }],
      gate: { ok: gate.ok, failed: gate.assets.filter((a) => !a.pass).map((a) => a.id) },
      postprocess: { snap: true, lock: true, outline: true },
      spent_usd: spent,
      notes: "",
    });
  writeFileSync(path.join(dir, "output.json"), output(0.01)); // $0.01 claimed on a $4.20 run
  const r = evalArtists(dir);
  assert.equal(r.pass, false);
  assert.ok(r.issues.some((i) => /records no art_generate charge/.test(i)), r.issues.join("; "));
  assert.ok(r.issues.some((i) => /far below the run's recorded spend 4\.2/.test(i)), r.issues.join("; "));
  // an honest claim still fails: generated assets with no ledgered charge is the lie signal itself
  writeFileSync(path.join(dir, "output.json"), output(4.1));
  const r2 = evalArtists(dir);
  assert.equal(r2.pass, false);
  assert.deepEqual(r2.issues.filter((i) => !/records no art_generate charge/.test(i)), []);
});
