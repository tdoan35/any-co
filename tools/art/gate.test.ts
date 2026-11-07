import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage, type RgbaImage } from "./png.ts";
import { DEFAULT_THRESHOLDS, runGate, validateSchema } from "./gate.ts";

const PALETTE = ["#1a1c2c", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#41a6f6"];
const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** A frames-wide horizontal strip of fw×fh frames; cell(f, x, y) → hex or null (transparent). */
function strip(frames: number, fw: number, fh: number, cell: (f: number, x: number, y: number) => string | null): RgbaImage {
  const img = makeImage(frames * fw, fh);
  for (let f = 0; f < frames; f++)
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const hex = cell(f, x, y);
        if (hex === null) continue;
        img.data.set([...rgb(hex), 255], (y * img.width + f * fw + x) * 4);
      }
  return img;
}

function frame0Sprite(hex: string): RgbaImage {
  return strip(1, 16, 16, (_f, x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? hex : null));
}

interface AssetFixture {
  id: string;
  type: "sprite" | "tileset" | "ui" | "audio" | "font" | "other";
  path: string;
  size?: { w: number; h: number };
  frames?: number;
  palette: string[];
  anchor: string | null;
  anim?: Record<string, unknown>;
  notes?: string;
  duration_s?: number;
}

interface ManifestFixture {
  schema_version: number;
  style_bible: string;
  grid: { w: number; h: number };
  palette: string[];
  assets: AssetFixture[];
}

function goodManifest(): ManifestFixture {
  return structuredClone({
    schema_version: 1,
    style_bible: "docs/style-bible.md",
    grid: { w: 16, h: 16 },
    palette: PALETTE,
    assets: [
      {
        id: "player",
        type: "sprite",
        path: "assets/sprites/player.png",
        size: { w: 64, h: 16 },
        frames: 4,
        palette: ["#1a1c2c", "#ffcd75"],
        anchor: null,
        anim: { mode: "frame-strip", fps: 8 },
        notes: "anchor sheet",
      },
      {
        id: "enemy-slug",
        type: "sprite",
        path: "assets/sprites/enemy-slug.png",
        size: { w: 32, h: 16 },
        frames: 2,
        palette: ["#1a1c2c", "#b13e53"],
        anchor: "player",
        anim: { mode: "cutout", parts: ["body"] },
      },
    ] satisfies AssetFixture[],
  });
}

function goodFiles(): Record<string, Uint8Array> {
  return {
    // 4 frames: #ffcd75 body plus one #1a1c2c detail pixel per frame ≥ 1 → drift 1/256 per pair
    "assets/sprites/player.png": encodePng(
      strip(4, 16, 16, (f, x, y) => {
        if (x >= 4 && x < 12 && y >= 4 && y < 12) return "#ffcd75";
        if (f > 0 && x === f && y === 15) return "#1a1c2c";
        return null;
      }),
    ),
    // 2 frames; frame 0 identical to player frame 0 → anchorDrift 0
    "assets/sprites/enemy-slug.png": encodePng(
      strip(2, 16, 16, (f, x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? (f === 0 ? "#ffcd75" : "#b13e53") : null)),
    ),
  };
}

function writeRepo(manifest: unknown, files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "artgate-"));
  for (const [rel, bytes] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "assets", "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

const schemaPath = path.resolve("docs/contracts/asset.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;

// ---- schema validator ----

test("validator accepts the contract's own schema and a valid manifest", () => {
  assert.deepEqual(validateSchema(goodManifest(), schema), []);
});

test("validator rejects each schema violation by name", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["wrong schema_version", { ...goodManifest(), schema_version: 2 }, /schema_version/],
    ["missing style_bible", (() => { const { style_bible: _omit, ...rest } = goodManifest(); return rest; })(), /style_bible/],
    ["bad palette hex", { ...goodManifest(), palette: ["#1a1c2c", "red"] }, /palette/],
    ["palette too short", { ...goodManifest(), palette: ["#1a1c2c"] }, /palette/],
    ["extra top-level property", { ...goodManifest(), extra: 1 }, /extra/],
    ["grid zero", { ...goodManifest(), grid: { w: 0, h: 16 } }, /grid/],
    ["bad asset id", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], id: "Player!" }] }, /id/],
    ["path outside assets/", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], path: "img/player.png" }] }, /path/],
    ["bad type enum", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], type: "mesh" }] }, /type/],
    ["bad anim mode", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], anim: { mode: "flip" } }] }, /anim/],
    ["fps over max", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], anim: { mode: "frame-strip", fps: 60 } }] }, /fps/],
    ["anchor wrong type", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], anchor: 3 }] }, /anchor/],
    ["empty assets", { ...goodManifest(), assets: [] }, /assets/],
    ["frames zero", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], frames: 0 }] }, /frames/],
    ["size fractional", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], size: { w: 16.5, h: 16 } }] }, /w/],
    ["notes too long", { ...goodManifest(), assets: [{ ...goodManifest().assets[0], notes: "x".repeat(301) }] }, /notes/],
  ];
  for (const [name, value, re] of cases) {
    const errors = validateSchema(value, schema);
    assert.ok(errors.length > 0, `${name}: expected errors`);
    assert.ok(re.test(errors.join(" ")), `${name}: "${errors.join("; ")}" lacks a path matching ${re}`);
  }
});

// ---- gate: passing repo ----

test("gate passes a healthy synthetic repo and reports drift numbers", () => {
  const dir = writeRepo(goodManifest(), goodFiles());
  const report = runGate(dir);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.manifest.valid, true);
  assert.deepEqual(report.files, { missing: [], unlisted: [] });
  const player = report.assets.find((a) => a.id === "player")!;
  assert.equal(player.pass, true);
  assert.equal(player.numbers.offPaletteShare, 0);
  assert.deepEqual(player.numbers.frameDrift, [1 / 256, 2 / 256, 2 / 256]); // detail pixel at x=f: pairs (1,2),(2,3) differ in 2 px
  assert.equal(player.numbers.anchorDrift, null); // anchor sheets have no anchor
  const slug = report.assets.find((a) => a.id === "enemy-slug")!;
  assert.equal(slug.pass, true);
  assert.equal(slug.numbers.anchorDrift, 0); // frame 0 identical to player frame 0
  assert.deepEqual(report.thresholds, DEFAULT_THRESHOLDS);
});

test("gate fails frame drift over the default threshold, and thresholds are options", () => {
  // fully alternating frames → drift 1.0 > default 0.5, but ≤ custom 1.0
  const files: Record<string, Uint8Array | string> = {
    "assets/sprites/player.png": encodePng(
      strip(4, 16, 16, (f, x, _y) => (f % 2 === 0 ? (x < 8 ? "#ffcd75" : "#1a1c2c") : x < 8 ? "#1a1c2c" : "#ffcd75")),
    ),
    "assets/sprites/enemy-slug.png": goodFiles()["assets/sprites/enemy-slug.png"],
  };
  const dir = writeRepo(goodManifest(), files);
  const strict = runGate(dir);
  assert.equal(strict.ok, false);
  const player = strict.assets.find((a) => a.id === "player")!;
  assert.equal(player.checks.find((c) => c.name === "frame_drift")!.pass, false);
  assert.deepEqual(player.numbers.frameDrift, [1, 1, 1]);
  const loose = runGate(dir, { thresholds: { maxFrameDrift: 1, maxAnchorDrift: 1 } });
  assert.equal(loose.ok, true, JSON.stringify(loose));
});

// ---- gate: failures ----

test("gate fails on off-palette pixels and reports the share", () => {
  const files: Record<string, Uint8Array | string> = {
    ...goodFiles(),
    "assets/sprites/enemy-slug.png": encodePng(
      strip(2, 16, 16, (f, x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? (f === 0 ? "#fe0000" : "#b13e53") : null)),
    ),
  };
  const report = runGate(writeRepo(goodManifest(), files));
  assert.equal(report.ok, false);
  const slug = report.assets.find((a) => a.id === "enemy-slug")!;
  assert.equal(slug.checks.find((c) => c.name === "pixels_in_palette")!.pass, false);
  assert.equal(slug.numbers.offPaletteShare, 64 / 128); // 64 of 128 opaque px off-palette
});

test("gate fails when the asset palette is not a subset of the locked palette", () => {
  const manifest = goodManifest();
  manifest.assets[1].palette = ["#1a1c2c", "#123456"];
  const report = runGate(writeRepo(manifest, goodFiles()));
  assert.equal(report.assets.find((a) => a.id === "enemy-slug")!.checks.find((c) => c.name === "palette_subset")!.pass, false);
  assert.equal(report.ok, false);
});

test("gate fails on a wrong declared size and on sizes that are not grid multiples", () => {
  const wrongSize = goodManifest();
  wrongSize.assets[0].size = { w: 60, h: 16 }; // real is 64x16
  const r1 = runGate(writeRepo(wrongSize, goodFiles()));
  assert.equal(r1.assets.find((a) => a.id === "player")!.checks.find((c) => c.name === "size")!.pass, false);
  assert.equal(r1.ok, false);

  const oddGrid = goodManifest();
  oddGrid.grid = { w: 5, h: 5 }; // 64x16 is not a 5-multiple
  const r2 = runGate(writeRepo(oddGrid, goodFiles()));
  assert.equal(r2.assets.find((a) => a.id === "player")!.checks.find((c) => c.name === "grid")!.pass, false);
  assert.equal(r2.ok, false);
});

test("gate fails when the frame count does not divide the strip width", () => {
  const manifest = goodManifest();
  manifest.assets[0].frames = 5; // 64/5 not integer
  const report = runGate(writeRepo(manifest, goodFiles()));
  assert.equal(report.assets.find((a) => a.id === "player")!.checks.find((c) => c.name === "frames")!.pass, false);
  assert.equal(report.ok, false);
});

test("gate fails on unknown and self anchors", () => {
  const unknown = goodManifest();
  unknown.assets[1].anchor = "ghost";
  const r1 = runGate(writeRepo(unknown, goodFiles()));
  assert.equal(r1.assets.find((a) => a.id === "enemy-slug")!.checks.find((c) => c.name === "anchor")!.pass, false);

  const selfRef = goodManifest();
  selfRef.assets[1].anchor = "enemy-slug";
  const r2 = runGate(writeRepo(selfRef, goodFiles()));
  assert.equal(r2.assets.find((a) => a.id === "enemy-slug")!.checks.find((c) => c.name === "anchor")!.pass, false);
  assert.equal(r2.ok, false);
});

test("gate fails on unlisted files under assets/ and missing manifest paths", () => {
  const files: Record<string, Uint8Array | string> = { ...goodFiles(), "assets/sprites/rogue.png": encodePng(frame0Sprite("#a7f070")) };
  const report = runGate(writeRepo(goodManifest(), files));
  assert.deepEqual(report.files.unlisted, ["assets/sprites/rogue.png"]);
  assert.equal(report.ok, false);

  const manifest = goodManifest();
  manifest.assets[1].path = "assets/sprites/vapor.png"; // declared, absent
  const r2 = runGate(writeRepo(manifest, goodFiles()));
  assert.deepEqual(r2.files.missing, ["assets/sprites/vapor.png"]);
  assert.equal(r2.ok, false);
});

test("gate fails on duplicate asset ids and on PNG assets without a declared size", () => {
  const dup = goodManifest();
  dup.assets[1].id = "player";
  const report = runGate(writeRepo(dup, goodFiles()));
  assert.equal(report.manifest.valid, false);
  assert.match(report.manifest.errors.join("; "), /duplicate/i);
  assert.equal(report.ok, false);

  const noSize = goodManifest();
  delete noSize.assets[0].size;
  const r2 = runGate(writeRepo(noSize, goodFiles()));
  assert.equal(r2.assets.find((a) => a.id === "player")!.checks.find((c) => c.name === "size")!.pass, false);
});

test("gate passes audio and non-PNG assets on existence alone", () => {
  const manifest = goodManifest();
  manifest.assets.push(
    { id: "jump", type: "audio", path: "assets/audio/jump.ogg", palette: [], anchor: null, duration_s: 1.5 },
    { id: "hud-font", type: "font", path: "assets/fonts/hud.ttf", palette: [], anchor: null },
  );
  const files: Record<string, Uint8Array | string> = { ...goodFiles(), "assets/audio/jump.ogg": "not really audio", "assets/fonts/hud.ttf": "not really a font" };
  const report = runGate(writeRepo(manifest, files));
  assert.equal(report.ok, true, JSON.stringify(report));
  const audio = report.assets.find((a) => a.id === "jump")!;
  assert.equal(audio.pass, true);
  assert.ok(!("offPaletteShare" in audio.numbers));
});

test("gate reports a missing or unreadable manifest without throwing", () => {
  const report = runGate(mkdtempSync(path.join(tmpdir(), "artgate-")));
  assert.equal(report.ok, false);
  assert.equal(report.manifest.valid, false);
  assert.match(report.manifest.errors.join("; "), /manifest/i);

  const r2 = runGate(writeRepo({ nonsense: true }, {}));
  assert.equal(r2.ok, false);
  assert.equal(r2.manifest.valid, false);
  assert.ok(r2.manifest.errors.length > 0);
  assert.deepEqual(r2.assets, []);
});

test("gate computes anchor drift against the anchor's frame 0 when sizes match, null otherwise", () => {
  // enemy frame 0 body shifted down 4 rows: 64 of 256 pixels differ from player frame 0
  const shifted: Record<string, Uint8Array | string> = {
    ...goodFiles(),
    "assets/sprites/enemy-slug.png": encodePng(
      strip(2, 16, 16, (f, x, y) =>
        f === 0
          ? x >= 4 && x < 12 && y >= 8 && y < 16
            ? "#ffcd75"
            : null
          : x >= 4 && x < 12 && y >= 4 && y < 12
            ? "#b13e53"
            : null,
      ),
    ),
  };
  const slug = runGate(writeRepo(goodManifest(), shifted)).assets.find((a) => a.id === "enemy-slug")!;
  assert.ok(Math.abs((slug.numbers.anchorDrift ?? -1) - 64 / 256) < 1e-9, `anchorDrift ${slug.numbers.anchorDrift}`);

  // mismatched frame size → skipped (null), check passes
  const manifest = goodManifest();
  manifest.assets[1].size = { w: 24, h: 16 }; // frame 0 is 12x16 vs player's 16x16
  const narrow: Record<string, Uint8Array | string> = {
    ...goodFiles(),
    "assets/sprites/enemy-slug.png": encodePng(strip(2, 12, 16, (_f, x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? "#b13e53" : null))),
  };
  const slug2 = runGate(writeRepo(manifest, narrow)).assets.find((a) => a.id === "enemy-slug")!;
  assert.equal(slug2.numbers.anchorDrift, null);
  assert.equal(slug2.checks.find((c) => c.name === "anchor_drift")!.pass, true);
});
