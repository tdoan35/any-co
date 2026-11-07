import { test } from "node:test";
import assert from "node:assert/strict";
import { makeImage, type RgbaImage } from "./png.ts";
import { addOutline, contactSheet, lockPalette, parseHex, splitStrip, snapToGrid } from "./ops.ts";

function solid(w: number, h: number, rgba: [number, number, number, number]): RgbaImage {
  const img = makeImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
  return img;
}

function px(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function paint(img: RgbaImage, x: number, y: number, rgba: [number, number, number, number]) {
  img.data.set(rgba, (y * img.width + x) * 4);
}

// ---- lockPalette ----

test("lockPalette snaps opaque pixels to the nearest palette color in OKLab", () => {
  const img = solid(2, 1, [254, 0, 0, 255]); // almost red
  paint(img, 1, 0, [0, 250, 0, 255]); // almost green
  const { image, stats } = lockPalette(img, ["#ff0000", "#00ff00"]);
  assert.deepEqual(px(image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(image, 1, 0), [0, 255, 0, 255]);
  assert.equal(stats.pixelsChanged, 2);
  assert.ok(stats.maxDistance > 0 && stats.maxDistance < 0.05, `maxDistance ${stats.maxDistance}`);
});

test("lockPalette binarizes alpha at the threshold (default 128) and keeps exact matches unchanged", () => {
  const img = solid(3, 1, [255, 0, 0, 255]);
  paint(img, 1, 0, [255, 0, 0, 200]); // above threshold → opaque
  paint(img, 2, 0, [255, 0, 0, 127]); // below threshold → transparent
  const { image, stats } = lockPalette(img, ["#ff0000"]);
  assert.deepEqual(px(image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(image, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(image, 2, 0), [0, 0, 0, 0]);
  assert.equal(stats.pixelsChanged, 2); // the 127-alpha pixel zeroes out, the 200-alpha pixel becomes fully opaque
  assert.equal(stats.maxDistance, 0);
});

test("lockPalette honors a custom alpha threshold", () => {
  const img = solid(1, 1, [255, 0, 0, 90]);
  const { image } = lockPalette(img, ["#ff0000"], { alphaThreshold: 80 });
  assert.deepEqual(px(image, 0, 0), [255, 0, 0, 255]);
});

test("lockPalette resolves exact-distance ties (duplicate entries) to the palette color and stays idempotent", () => {
  // Exact ties are only constructible with identical entries; distance 0 to both → first entry,
  // and the output must already be locked (a second pass changes nothing).
  const img = solid(1, 1, [17, 34, 51, 255]);
  const once = lockPalette(img, ["#112233", "#112233", "#000000"]);
  assert.deepEqual(px(once.image, 0, 0), [17, 34, 51, 255]);
  const twice = lockPalette(once.image, ["#112233", "#112233", "#000000"]);
  assert.equal(twice.stats.pixelsChanged, 0);
  assert.equal(twice.stats.maxDistance, 0);
});

test("lockPalette is pure and byte-deterministic", () => {
  const img = solid(4, 4, [10, 200, 30, 255]);
  paint(img, 2, 2, [90, 90, 90, 40]);
  const before = Uint8Array.from(img.data);
  const a = lockPalette(img, ["#000000", "#ffffff", "#0ac81e"]);
  const b = lockPalette(img, ["#000000", "#ffffff", "#0ac81e"]);
  assert.deepEqual(a.image.data, b.image.data);
  assert.deepEqual(img.data, before); // input untouched
});

test("lockPalette rejects an empty palette and malformed hex", () => {
  const img = solid(1, 1, [1, 2, 3, 255]);
  assert.throws(() => lockPalette(img, []), /palette/i);
  assert.throws(() => lockPalette(img, ["red"]), /#rrggbb|hex/i);
});

test("parseHex parses #rrggbb and rejects other shapes", () => {
  assert.deepEqual(parseHex("#0a1B2c"), [10, 27, 44]);
  assert.throws(() => parseHex("0a1b2c"), /#rrggbb|hex/i);
  assert.throws(() => parseHex("#0a1b2"), /#rrggbb|hex/i);
});

// ---- snapToGrid ----

test("snapToGrid downscales by majority vote and reports an integer scale", () => {
  // 4x4 target from an 8x8 source: 2x2 blocks of one color each
  const img = solid(8, 8, [0, 0, 0, 0]);
  const cells: Array<[number, number, [number, number, number, number]]> = [
    [0, 0, [255, 0, 0, 255]],
    [1, 0, [0, 255, 0, 255]],
    [0, 1, [0, 0, 255, 255]],
    [1, 1, [255, 255, 0, 255]],
  ];
  for (const [cx, cy, color] of cells) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) paint(img, cx * 2 + dx, cy * 2 + dy, color);
  const r = snapToGrid(img, { w: 4, h: 4 });
  assert.equal(r.image.width, 4);
  assert.equal(r.image.height, 4);
  assert.deepEqual(px(r.image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(r.image, 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(px(r.image, 0, 1), [0, 0, 255, 255]);
  assert.deepEqual(px(r.image, 1, 1), [255, 255, 0, 255]);
  assert.equal(r.scaleX, 2);
  assert.equal(r.scaleY, 2);
  assert.equal(r.uniform, true);
  assert.equal(r.integerScale, true);
});

test("snapToGrid majority ignores minority pixels inside a cell", () => {
  const img = solid(4, 2, [9, 9, 9, 255]); // 4x2 → two 2x2 cells per row? here w=2,h=1 target
  paint(img, 0, 0, [1, 1, 1, 255]); // 1 of 4 pixels differs in cell (0,0)
  const r = snapToGrid(img, { w: 2, h: 1 });
  assert.deepEqual(px(r.image, 0, 0), [9, 9, 9, 255]);
  assert.deepEqual(px(r.image, 1, 0), [9, 9, 9, 255]);
});

test("snapToGrid breaks count ties by the lexicographically smallest RGBA tuple", () => {
  const img = solid(2, 1, [255, 0, 0, 255]);
  paint(img, 1, 0, [0, 0, 255, 255]); // 1 vs 1 tie → (0,0,255,255) sorts first
  const r = snapToGrid(img, { w: 1, h: 1 });
  assert.deepEqual(px(r.image, 0, 0), [0, 0, 255, 255]);
});

test("snapToGrid keeps transparent as a votable color and handles non-integer scales", () => {
  const img = solid(5, 5, [0, 0, 0, 0]);
  paint(img, 0, 0, [1, 2, 3, 255]); // cell x in [0,3) y in [0,3): 1 of 9 → transparent wins
  const r = snapToGrid(img, { w: 2, h: 2 });
  assert.deepEqual(px(r.image, 0, 0), [0, 0, 0, 0]);
  assert.equal(r.integerScale, false);
  assert.equal(r.scaleX, 2.5);
  assert.equal(r.uniform, true);
});

test("snapToGrid rejects targets larger than the source or non-positive sizes", () => {
  const img = solid(4, 4, [0, 0, 0, 255]);
  assert.throws(() => snapToGrid(img, { w: 5, h: 4 }), /at least|smaller|larger/i);
  assert.throws(() => snapToGrid(img, { w: 0, h: 4 }), /positive|integer|target/i);
});

// ---- addOutline ----

test("addOutline outlines transparent pixels 4-adjacent to opaque ones", () => {
  const img = solid(3, 3, [0, 0, 0, 0]);
  paint(img, 1, 1, [10, 20, 30, 255]);
  const out = addOutline(img, "#ff00ff");
  assert.deepEqual(px(out, 1, 1), [10, 20, 30, 255]); // opaque center unchanged
  for (const [x, y] of [[1, 0], [0, 1], [2, 1], [1, 2]] as const)
    assert.deepEqual(px(out, x, y), [255, 0, 255, 255], `outline at ${x},${y}`);
  for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const)
    assert.deepEqual(px(out, x, y), [0, 0, 0, 0], `corner ${x},${y} untouched (not 4-adjacent)`);
});

test("addOutline leaves the input untouched and rejects unknown modes", () => {
  const img = solid(3, 3, [0, 0, 0, 0]);
  paint(img, 1, 1, [5, 5, 5, 255]);
  const before = Uint8Array.from(img.data);
  addOutline(img, "#ffffff");
  assert.deepEqual(img.data, before);
  assert.throws(() => addOutline(img, "#ffffff", { mode: "inner" as never }), /mode/i);
});

// ---- contactSheet ----

test("contactSheet lays frames out anchor-first at integer scale with gap, and maps cells", () => {
  const a = solid(2, 2, [255, 0, 0, 255]);
  const b = solid(2, 2, [0, 255, 0, 255]);
  const c = solid(2, 2, [0, 0, 255, 255]);
  const { image, cells } = contactSheet([a, b, c], { anchor: 1, scale: 2, gap: 1 });
  assert.equal(image.width, 3 * 4 + 2); // 3 cells of 4px + 2 gaps
  assert.equal(image.height, 4);
  assert.deepEqual(
    cells,
    [
      { frame: 1, x: 0, y: 0, w: 4, h: 4 },
      { frame: 0, x: 5, y: 0, w: 4, h: 4 },
      { frame: 2, x: 10, y: 0, w: 4, h: 4 },
    ],
  );
  // first cell holds upscaled frame b (the anchor)
  for (const [x, y] of [[0, 0], [3, 0], [0, 3], [3, 3]] as const) assert.deepEqual(px(image, x, y), [0, 255, 0, 255]);
  assert.deepEqual(px(image, 4, 0), [0, 0, 0, 0]); // gap column
  assert.deepEqual(px(image, 5, 0), [255, 0, 0, 255]); // frame a upscaled
});

test("contactSheet defaults: scale 1, gap 0, anchor 0, given order", () => {
  const a = solid(1, 1, [1, 1, 1, 255]);
  const b = solid(1, 1, [2, 2, 2, 255]);
  const { image, cells } = contactSheet([a, b]);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual(cells, [
    { frame: 0, x: 0, y: 0, w: 1, h: 1 },
    { frame: 1, x: 1, y: 0, w: 1, h: 1 },
  ]);
});

test("contactSheet rejects mismatched frame sizes and bad scale/gap/anchor", () => {
  const a = solid(2, 2, [1, 1, 1, 255]);
  const b = solid(3, 2, [1, 1, 1, 255]);
  assert.throws(() => contactSheet([a, b]), /size/i);
  assert.throws(() => contactSheet([a], { scale: 0 }), /scale/i);
  assert.throws(() => contactSheet([a], { scale: 1.5 }), /integer/i);
  assert.throws(() => contactSheet([a], { gap: -1 }), /gap/i);
  assert.throws(() => contactSheet([a], { anchor: 1 }), /anchor/i);
  assert.throws(() => contactSheet([]), /frame/i);
});

// ---- splitStrip ----

test("splitStrip cuts a horizontal strip into equal frames", () => {
  const img = solid(8, 2, [0, 0, 0, 0]);
  for (let f = 0; f < 4; f++) paint(img, f * 2, 0, [f * 10, 0, 0, 255]);
  const frames = splitStrip(img, 4);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].width, 2);
  assert.equal(frames[0].height, 2);
  assert.deepEqual(px(frames[2], 0, 0), [20, 0, 0, 255]);
  assert.deepEqual(px(frames[3], 0, 0), [30, 0, 0, 255]);
  assert.deepEqual(px(frames[0], 1, 1), [0, 0, 0, 0]);
});

test("splitStrip rejects widths that do not divide by the frame count", () => {
  const img = solid(7, 2, [1, 1, 1, 255]);
  assert.throws(() => splitStrip(img, 3), /divis|width/i);
  assert.throws(() => splitStrip(img, 0), /frames/i);
});
