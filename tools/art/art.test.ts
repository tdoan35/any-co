import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodePng, encodePng, makeImage } from "./png.ts";
import { runCommand } from "./art.ts";
import { IMPLS } from "../../runner/tools/impl.ts";
import type { ToolContext } from "../../runner/tools/impl.ts";

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), "artcli-"));
}

function writeTestPng(dir: string, name: string, w = 4, h = 4, paint?: (x: number, y: number) => [number, number, number, number]): string {
  const img = makeImage(w, h);
  if (paint)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) img.data.set(paint(x, y), (y * w + x) * 4);
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(img));
  return file;
}

// ---- CLI ----

test("lock writes a locked PNG and reports stats", () => {
  const dir = temp();
  const inPng = writeTestPng(dir, "in.png", 2, 2, () => [200, 10, 10, 255]);
  const out = path.join(dir, "out.png");
  const r = runCommand(["lock", inPng, out, "--palette", "#ff0000,#00ff00"]);
  assert.equal(r.kind, "ok");
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.pixelsChanged, 4);
  const img = decodePng(new Uint8Array(readFileSync(out)));
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [255, 0, 0, 255]);
});

test("snap downsizes and reports scale metadata", () => {
  const dir = temp();
  const inPng = writeTestPng(dir, "big.png", 8, 8, (x, _y) => (x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
  const out = path.join(dir, "small.png");
  const r = runCommand(["snap", inPng, out, "--w", "2", "--h", "1"]);
  assert.equal(r.kind, "ok");
  assert.equal(r.json.scaleX, 4);
  assert.equal(r.json.integerScale, true);
  const img = decodePng(new Uint8Array(readFileSync(out)));
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [255, 0, 0, 255]); // left half red
  assert.deepEqual(Array.from(img.data.slice(4, 8)), [0, 255, 0, 255]);
});

test("outline writes an outlined PNG", () => {
  const dir = temp();
  const inPng = writeTestPng(dir, "dot.png", 3, 3, (x, y) => (x === 1 && y === 1 ? [5, 5, 5, 255] : [0, 0, 0, 0]));
  const out = path.join(dir, "outlined.png");
  const r = runCommand(["outline", inPng, out, "--color", "#00ffff"]);
  assert.equal(r.kind, "ok");
  const img = decodePng(new Uint8Array(readFileSync(out)));
  const at = (x: number, y: number) => Array.from(img.data.slice((y * 3 + x) * 4, (y * 3 + x) * 4 + 4));
  assert.deepEqual(at(1, 0), [0, 255, 255, 255]);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
});

test("strip writes numbered frames", () => {
  const dir = temp();
  const inPng = writeTestPng(dir, "strip.png", 8, 2, (x, _y) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const r = runCommand(["strip", inPng, "--frames", "2"]);
  assert.equal(r.kind, "ok");
  assert.equal(r.json.frames, 2);
  assert.ok(existsSync(path.join(String(r.json.outDir), "frame-0.png")));
  assert.ok(existsSync(path.join(String(r.json.outDir), "frame-1.png")));
});

test("sheet writes the sheet and its cells sidecar", () => {
  const dir = temp();
  const a = writeTestPng(dir, "a.png", 2, 2, () => [255, 0, 0, 255]);
  const b = writeTestPng(dir, "b.png", 2, 2, () => [0, 255, 0, 255]);
  const out = path.join(dir, "sheet.png");
  const r = runCommand(["sheet", out, "--frames", `${a},${b}`, "--anchor", "1", "--scale", "2", "--gap", "1"]);
  assert.equal(r.kind, "ok");
  const sidecar = path.join(dir, "sheet.cells.json");
  assert.ok(existsSync(sidecar));
  const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.ok(parsed instanceof Object && "cells" in parsed && Array.isArray(parsed.cells), "sidecar has cells");
  const cells = (parsed as { cells: Array<{ frame: number }> }).cells; // narrowed by the assert above
  assert.deepEqual(cells.map((c) => c.frame), [1, 0]); // anchor first
});

function gateRepo(dir: string): string {
  const repo = path.join(dir, "game");
  mkdirSync(path.join(repo, "assets", "sprites"), { recursive: true });
  const img = makeImage(16, 16);
  for (let i = 0; i < 256; i++) img.data.set([1, 2, 3, 255], i * 4); // #010203, arbitrary test color
  writeFileSync(path.join(repo, "assets", "sprites", "player.png"), encodePng(img));
  writeFileSync(
    path.join(repo, "assets", "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      style_bible: "docs/style-bible.md",
      grid: { w: 16, h: 16 },
      palette: ["#010203", "#040506"],
      assets: [{ id: "player", type: "sprite", path: "assets/sprites/player.png", size: { w: 16, h: 16 }, frames: 1, palette: ["#010203"], anchor: null }],
    }),
  );
  return repo;
}

test("gate returns exit 0 on a healthy repo and 1 on a failing one", () => {
  const dir = temp();
  const ok = runCommand(["gate", gateRepo(dir)]);
  assert.equal(ok.kind, "ok");
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.json.ok, true);

  // break it: unlisted file
  const repo2 = gateRepo(temp());
  writeTestPng(repo2, "assets/sprites/extra.png", 16, 16, () => [1, 2, 3, 255]);
  const bad = runCommand(["gate", repo2]);
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.json.ok, false);
});

test("unknown commands and bad invocations exit non-zero with an error message", () => {
  const bad = runCommand(["frobnicate"]);
  assert.equal(bad.kind, "error");
  assert.equal(bad.exitCode, 2);
  const missing = runCommand(["lock", "only-one-arg"]);
  assert.equal(missing.kind, "error");
  assert.equal(missing.exitCode, 2); // usage errors are 2, not a gate-fail 1
  const crash = runCommand(["lock", path.join(temp(), "no-such-input.png"), path.join(temp(), "out.png"), "--palette", "#000000"]);
  assert.equal(crash.kind, "error");
  assert.equal(crash.exitCode, 2); // crashes (unreadable input) are 2; 1 is reserved for gate verdicts
});

// ---- runner capability (art_tools) ----

function ctx(workspace: string): ToolContext {
  return { workspace, naive: null };
}

test("art_lock runs inside the agent workspace", async () => {
  const ws = temp();
  writeTestPng(ws, "in.png", 2, 2, () => [10, 200, 30, 255]);
  const out = await IMPLS.art_tools.art_lock.run({ path: "in.png", out: "out.png", palette: ["#000000", "#0ac81e"] }, ctx(ws));
  assert.equal(JSON.parse(out.content).pixelsChanged, 0); // #0ac81e is already the palette color
  assert.ok(existsSync(path.join(ws, "out.png")));
});

test("art_gate checks the game clone inside the workspace and reports JSON", async () => {
  const ws = temp();
  const repo = gateRepo(ws); // gateRepo writes <ws>/game/...
  void repo;
  const out = await IMPLS.art_tools.art_gate.run({}, ctx(ws));
  assert.equal(JSON.parse(out.content).ok, true);

  writeTestPng(path.join(ws, "game"), "assets/sprites/extra.png", 16, 16, () => [1, 2, 3, 255]);
  const bad = await IMPLS.art_tools.art_gate.run({}, ctx(ws));
  assert.equal(JSON.parse(bad.content).ok, false);
});

test("art tools refuse paths that escape the workspace", async () => {
  const ws = temp();
  writeTestPng(ws, "in.png", 1, 1, () => [1, 1, 1, 255]);
  const out = await IMPLS.art_tools.art_lock.run({ path: "../in.png", out: "out.png", palette: ["#000000"] }, ctx(ws));
  assert.equal(out.is_error, true);
  assert.match(out.content, /escape/i);
});
