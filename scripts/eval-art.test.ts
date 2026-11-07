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
  const dir = mkdtempSync(path.join(tmpdir(), "arteval-"));
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
  assert.ok(r2.issues.some((i) => i.includes("bible palette")), r2.issues.join("; "));
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
