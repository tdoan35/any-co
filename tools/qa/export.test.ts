import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, makeImage, type RgbaImage } from "../art/png.ts";
import { blankIssues, exportCheck, frameStats, missingAutoloads, parseAutoloads, pickFrames, readPck, runPack } from "./export.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => mkdtempSync(path.join(tmpdir(), "qa-export-test-"));

/** A synthetic Godot pack: format 4 (directory at an offset, like 4.7 writes) or format 2 (directory after the header). */
function pck(files: string[], opts: { version?: 2 | 4; encrypted?: boolean; resPrefix?: boolean } = {}): Buffer {
  const version = opts.version ?? 4;
  const entry = (p: string) => {
    const name = Buffer.from((opts.resPrefix ? "res://" : "") + p, "utf8");
    const padded = Buffer.alloc(Math.ceil(name.length / 4) * 4);
    name.copy(padded);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(padded.length);
    return Buffer.concat([len, padded, Buffer.alloc(8 + 8 + 16 + 4)]);
  };
  const dir = Buffer.concat([Buffer.from(Uint32Array.of(files.length).buffer), ...files.map(entry)]);
  const head = Buffer.alloc(version >= 3 ? 0x70 : 0x60);
  head.write("GDPC", 0, "latin1");
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(4, 8);
  head.writeUInt32LE(7, 12);
  head.writeUInt32LE(2, 16);
  head.writeUInt32LE(opts.encrypted ? 1 : 2, 20);
  if (version >= 3) {
    head.writeBigUInt64LE(BigInt(head.length), 24);
    head.writeBigUInt64LE(BigInt(head.length + 16), 32); // directory after 16 bytes of "file data"
    return Buffer.concat([head, Buffer.alloc(16), dir]);
  }
  return Buffer.concat([head, dir]); // v2: magic+version 8, engine 12, flags 4, file_base 8, reserved 64 = 0x60
}

const PROJECT = '[application]\nconfig/name="X"\n\n[autoload]\nSim="*res://src/sim.gd"\nAudio="res://src/audio/bus.tscn"\n\n[display]\nwindow/size=1\n';

/** A game dir with project.godot and dist/web/index.pck holding `files`. */
function game(files: string[], opts?: Parameters<typeof pck>[1]): string {
  const dir = tmp();
  writeFileSync(path.join(dir, "project.godot"), PROJECT);
  mkdirSync(path.join(dir, "dist", "web"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "web", "index.pck"), pck(files, opts));
  return dir;
}
const SHIPPED = ["project.binary", "scenes/main.tscn.remap", "src/sim.gdc", "src/sim.gd.remap", "src/audio/bus.tscn.remap"];

test("pack table: format 4 and format 2 directories parse; res:// is stripped", () => {
  for (const [version, resPrefix] of [[4, false], [2, true]] as const) {
    const info = readPck(new Uint8Array(pck(SHIPPED, { version, resPrefix })));
    assert.deepEqual(info.files, SHIPPED, `v${version}`);
    assert.equal(info.version, version);
    assert.equal(info.engine, "4.7.2");
  }
  assert.throws(() => readPck(new Uint8Array(Buffer.from("PK\x03\x04 not a pack at all, just padding ".repeat(4)))), /no GDPC magic/);
  assert.throws(() => readPck(new Uint8Array(pck(SHIPPED, { encrypted: true }))), /encrypted/);
});

test("autoloads: parsed from project.godot and found as .gdc / .remap; a missing one is named", () => {
  const autoloads = parseAutoloads(PROJECT);
  assert.deepEqual(autoloads, [{ name: "Sim", path: "res://src/sim.gd" }, { name: "Audio", path: "res://src/audio/bus.tscn" }]);
  assert.deepEqual(missingAutoloads(autoloads, SHIPPED), []);
  assert.deepEqual(missingAutoloads(autoloads, ["src/sim.gd"]), ["Audio (res://src/audio/bus.tscn)"]);
  // today's bug: scenes ship, src/* doesn't (a scene still *references* res://src/..., which a strings scan would accept)
  assert.deepEqual(missingAutoloads(autoloads, ["project.binary", "scenes/main.tscn.remap"]), ["Sim (res://src/sim.gd)", "Audio (res://src/audio/bus.tscn)"]);
});

test("export check: a pack missing its autoload fails (no engine needed)", async () => {
  const bad = await exportCheck({ gameDir: game(["project.binary", "scenes/main.tscn.remap"]), run: false });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.checks[0].detail, /missing from the pack: Sim \(res:\/\/src\/sim\.gd\), Audio/);
  const good = await exportCheck({ gameDir: game(SHIPPED), run: false });
  assert.equal(good.exitCode, 0, JSON.stringify(good.checks));
  const none = await exportCheck({ gameDir: tmp(), run: false });
  assert.equal(none.exitCode, 2);
  const noPack = tmp();
  writeFileSync(path.join(noPack, "project.godot"), PROJECT);
  const missing = await exportCheck({ gameDir: noPack, run: false });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.checks[0].detail, /missing \(run build.sh build-web first\)/);
});

// ---- frames ----

function fill(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const img = makeImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([...rgb, 255], i * 4);
  return img;
}
/** A busy frame: a grid of 16 colours over the whole image. */
function busy(w = 160, h = 90): RgbaImage {
  const img = fill(w, h, [10, 10, 10]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x >> 3) % 2 === 0) img.data.set([(x * 13) % 256, (y * 29) % 256, ((x + y) * 7) % 256, 255], (y * w + x) * 4);
  return img;
}
/** What Ty saw: a HUD bar along the top and bottom edges, the board area empty. */
function hudOnly(w = 160, h = 90): RgbaImage {
  const img = fill(w, h, [20, 20, 30]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (y < 10 || y >= h - 10) img.data.set([(x * 17) % 256, 200, (x * 5) % 256, 255], (y * w + x) * 4);
  return img;
}

test("blank frame fails; a busy frame passes; a HUD-only frame fails on the centre", () => {
  const blank = blankIssues(frameStats(fill(120, 80, [0, 0, 0])));
  assert.equal(blank.length, 3, blank.join("; "));
  // the shipped bug's floor: 36 non-background pixels of 14,400 is 0.25%, far under 5%
  const sparse = fill(120, 120, [0, 0, 0]);
  for (let i = 0; i < 36; i++) sparse.data.set([255, 255, 255, 255], (i * 397) % (120 * 120) * 4);
  assert.match(blankIssues(frameStats(sparse)).join("; "), /whole frame: 0\.25% non-background/);
  assert.deepEqual(blankIssues(frameStats(busy())), []);
  const hud = frameStats(hudOnly());
  assert.ok(hud.whole.nonBackgroundShare > 0.05, "the whole frame looks busy");
  assert.match(blankIssues(hud).join("; "), /central region: 0\.00% non-background/);
  const twoColours = fill(100, 100, [0, 0, 0]);
  for (let i = 0; i < 5000; i++) twoColours.data.set([255, 0, 0, 255], i * 4);
  assert.match(blankIssues(frameStats(twoColours)).join("; "), /only 2 unique colours/);
});

// ---- native run, against a fake engine (the real one is the live test below) ----

/** A fake `godot`: renders FAKE_FRAME into the --write-movie sequence, or fails like a broken pack. */
function fakeGodot(frame: RgbaImage | null, mode: "ok" | "broken" = "ok"): { bin: string; argvFile: string } {
  const dir = tmp();
  const framePng = path.join(dir, "frame.bin");
  if (frame) writeFileSync(framePng, encodePng(frame));
  const argvFile = path.join(dir, "argv.json");
  const bin = path.join(dir, "godot");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: a, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()) }));
if (${JSON.stringify(mode)} === "broken") {
  console.error("ERROR: Failed loading resource: res://src/sim.gd.");
  console.error("ERROR: Failed loading scene: res://scenes/main.tscn.");
  process.exit(1);
}
const movie = a[a.indexOf("--write-movie") + 1], n = Number(a[a.indexOf("--quit-after") + 1]);
const bytes = fs.readFileSync(${JSON.stringify(framePng)});
for (let i = 0; i < n; i++) fs.writeFileSync(movie.replace(/\\.png$/, String(i).padStart(8, "0") + ".png"), bytes);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, argvFile };
}

test("native run: a working pack renders frames and its busy last frame passes; argv loads only the pack", async () => {
  const g = game(SHIPPED);
  const fake = fakeGodot(busy());
  const r = await exportCheck({ gameDir: g, frames: 12, godot: fake.bin });
  assert.equal(r.exitCode, 0, JSON.stringify(r.checks, null, 1));
  assert.deepEqual(r.checks.map((c) => c.name), ["web/index.pck: autoloads shipped", "web/index.pck: runs natively", "web/index.pck: last frame not blank"]);
  assert.equal(r.packs[0].run?.frames, 12);
  const seen = JSON.parse(readFileSync(fake.argvFile, "utf8"));
  assert.deepEqual(seen.argv.slice(0, 2), ["--main-pack", path.join(g, "dist", "web", "index.pck")]);
  assert.ok(seen.argv.includes("--write-movie") && seen.argv.includes("--fixed-fps"));
  assert.ok(!seen.cwdFiles.includes("project.godot"), "the engine runs from a dir with no project, so only the pack loads");
});

test("native run: a pack that fails to load, or renders a blank frame, fails with the engine's words", async () => {
  const broken = await exportCheck({ gameDir: game(SHIPPED), godot: fakeGodot(null, "broken").bin });
  assert.equal(broken.exitCode, 1);
  const run = broken.checks.find((c) => c.name.endsWith("runs natively"))!;
  assert.match(run.detail, /engine exit 1; no frames rendered; ERROR: Failed loading resource: res:\/\/src\/sim\.gd/);
  const blank = await exportCheck({ gameDir: game(SHIPPED), frames: 5, godot: fakeGodot(fill(160, 90, [0, 0, 0])).bin });
  assert.equal(blank.exitCode, 1);
  assert.match(blank.checks.at(-1)!.detail, /0\.0% non-bg.*whole frame: 0\.00% non-background/);
  const hung = await runPack(path.join(game(SHIPPED), "dist", "web", "index.pck"), { godot: "/bin/sleep", frames: 1, timeoutMs: 300 });
  assert.equal(hung.frames, 0);
  const nope = await runPack("x.pck", { godot: path.join(tmp(), "no-such-godot"), frames: 1 });
  assert.equal(nope.exitCode, null);
  assert.match(nope.outputTail, /spawn error/);
});

test("windows packs are checked too when present", async () => {
  const g = game(SHIPPED);
  mkdirSync(path.join(g, "dist", "windows"), { recursive: true });
  writeFileSync(path.join(g, "dist", "windows", "game.pck"), pck(["project.binary"]));
  const r = await exportCheck({ gameDir: g, run: false });
  assert.deepEqual(r.packs.map((p) => p.pck), ["web/index.pck", path.join("windows", "game.pck")]);
  assert.equal(r.exitCode, 1);
  assert.match(r.checks[1].detail, /missing from the pack: Sim/);
});

// ---- live: the studio's real game, exported in a temp clone (read-only on games/) ----

const LIVE_GAME = process.env.QA_LIVE_GAME ?? path.join(REPO, "games", "caravan-cargo-cult");
const liveSkip = process.env.QA_LIVE !== "1"
  ? "set QA_LIVE=1 (and QA_LIVE_GAME=<games/caravan-cargo-cult>) to export the real game in a temp clone and gate it; needs godot + export templates, opens a window"
  : !existsSync(path.join(LIVE_GAME, "project.godot")) ? `no game at ${LIVE_GAME}` : false;

test("LIVE: games/caravan-cargo-cult main exported in a temp clone: fails while export_presets excludes src/*, passes once it does not", { skip: liveSkip, timeout: 600_000 }, async () => {
  const clone = path.join(tmp(), "game");
  execFileSync("git", ["clone", "-q", LIVE_GAME, clone]); // reads games/, writes only the temp clone
  execFileSync("bash", ["build.sh", "build-web"], { cwd: clone, stdio: "ignore", timeout: 300_000 });
  const r = await exportCheck({ gameDir: clone, frames: 60 });
  console.log(JSON.stringify(r.checks, null, 1));
  const excludesSrc = /exclude_filter="[^"]*\bsrc\/\*/.test(readFileSync(path.join(clone, "export_presets.cfg"), "utf8"));
  if (excludesSrc) {
    assert.equal(r.exitCode, 1);
    assert.ok(r.checks.some((c) => c.name.endsWith("autoloads shipped") && !c.pass));
  } else assert.equal(r.exitCode, 0, "the tech-lead's export fix has landed: the gate should pass");
});

test("T33: save_frames copies evenly spaced frames (always the last) out of the run dir for UI review", async () => {
  assert.deepEqual(pickFrames(12, 3), [3, 7, 11]);
  assert.deepEqual(pickFrames(5, 12), [0, 1, 2, 3, 4]);
  assert.deepEqual(pickFrames(90, 1), [89]);
  assert.deepEqual(pickFrames(0, 3), []);
  const g = game(SHIPPED);
  const saveDir = path.join(tmp(), "media", "export-frames");
  const r = await exportCheck({ gameDir: g, frames: 12, godot: fakeGodot(busy()).bin, saveFrames: 3, saveDir });
  assert.equal(r.exitCode, 0, JSON.stringify(r.checks));
  const saved = r.packs[0].run?.saved_frames ?? [];
  assert.deepEqual(saved.map((f) => path.relative(saveDir, f)), ["web-index/frame-0003.png", "web-index/frame-0007.png", "web-index/frame-0011.png"]);
  for (const f of saved) assert.equal(decodePng(new Uint8Array(readFileSync(f))).width, busy().width);
  const none = await exportCheck({ gameDir: g, frames: 4, godot: fakeGodot(busy()).bin });
  assert.equal(none.packs[0].run?.saved_frames, undefined, "nothing is saved unless asked");
});
