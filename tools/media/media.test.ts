import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, makeImage } from "../art/png.ts";
import { capture, launchArgv } from "./capture.ts";
import { FFMPEG, edit, hasFfmpeg, probe } from "./edit.ts";
import { IMPLS } from "../../runner/tools/impl.ts";

// The fake game is a test double for "a desktop build that implements docs/contracts" (never under games/).
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata", "fake-game.mjs");
const FF = hasFfmpeg();
const NO_FF = FF ? false : "ffmpeg/ffprobe not found on PATH (brew install ffmpeg): skipping ffmpeg tests";

function tempGame(): { root: string; game: string; out: string } {
  const root = mkdtempSync(path.join(tmpdir(), "media-"));
  const game = path.join(root, "game");
  mkdirSync(game, { recursive: true });
  writeFileSync(path.join(game, "trailer.jsonl"), '{"tick": 10, "input": "move", "args": {"x": 1, "y": 0}}\n');
  return { root, game, out: path.join(root, "media", "shots") };
}
const base = (game: string, out: string) => ({
  gameDir: game, launch: [process.execPath, FAKE], seed: 7, timeScale: 1, policy: "script:trailer.jsonl",
  resolution: { w: 64, h: 36 }, outDir: out, timeoutMs: 10_000, graceMs: 500, pollMs: 2,
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("launch argv: prefix, engine movie args, separator, then the contract flags", () => {
  const argv = launchArgv({ launch: ["godot", "--path", "."], separator: "--", seed: 3, timeScale: 2, policy: "script:p.jsonl", resolution: { w: 320, h: 180 }, mode: { kind: "movie", file: "/w/media/x/footage.avi", exit_after_ticks: 600 } });
  assert.deepEqual(argv, ["godot", "--path", ".", "--write-movie", "/w/media/x/footage.avi", "--", "--qa", "--seed", "3", "--time-scale", "2", "--autoplay", "--policy", "script:p.jsonl", "--resolution", "320x180", "--exit-after-ticks", "600"]);
  assert.throws(() => launchArgv({ launch: ["g"], seed: 1, timeScale: 1, policy: "cheat", resolution: { w: 1, h: 1 }, mode: { kind: "ticks", ticks: [1] } }), /policy/);
  assert.throws(() => launchArgv({ launch: ["g"], seed: 1, timeScale: 50, policy: "random", resolution: { w: 1, h: 1 }, mode: { kind: "ticks", ticks: [1] } }), /time_scale/);
});

test("ticks mode: pauses, steps to each tick exactly, screenshots, quits cleanly", async () => {
  const { game, out } = tempGame();
  const r = await capture({ ...base(game, out), mode: { kind: "ticks", ticks: [300, 120, 120, 600] } });
  assert.deepEqual(r.shots.map((s) => s.tick), [120, 300, 600]);
  const logged = readFileSync(path.join(game, "qa", "shots.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).tick);
  assert.deepEqual(logged, [120, 300, 600], "the game took each shot at exactly the requested tick");
  for (const s of r.shots) {
    const img = decodePng(new Uint8Array(readFileSync(s.file)));
    assert.deepEqual([img.width, img.height], [64, 36]);
    assert.ok(s.file.startsWith(out));
  }
  assert.equal(r.exit.killed, false);
  assert.equal(r.exit.code, 0);
  assert.deepEqual(r.notes, []);
  const argv = JSON.parse(readFileSync(path.join(game, "qa", "argv.json"), "utf8"));
  assert.deepEqual(argv, ["--qa", "--seed", "7", "--time-scale", "1", "--autoplay", "--policy", "script:trailer.jsonl", "--resolution", "64x36"]);
});

test("events mode: shots on matching events (every/max), stops at run_end", async () => {
  const { game, out } = tempGame();
  const r = await capture({ ...base(game, out), mode: { kind: "events", triggers: [{ event: "wave", max: 2 }, { event: "death" }], max_shots: 10 } });
  assert.deepEqual(r.shots.map((s) => s.trigger.split(" ")[0]), ["wave", "wave", "death"]);
  for (const s of r.shots) assert.ok(s.tick >= Number(s.trigger.match(/event tick (\d+)/)![1]), "the shot comes at or after the event's tick");
  assert.ok(r.events_seen >= 5);
  assert.equal(r.exit.killed, false);
});

test("a game that never signals ready times out and is killed", async () => {
  const { game, out } = tempGame();
  const t0 = Date.now();
  await assert.rejects(capture({ ...base(game, out), timeoutMs: 400, env: { FAKE_MODE: "no-ready" }, mode: { kind: "ticks", ticks: [5] } }), /timed out waiting for the game's ready ack/);
  assert.ok(Date.now() - t0 < 5000);
  const pid = Number(readFileSync(path.join(game, "qa", "pid"), "utf8"));
  assert.equal(alive(pid), false, "the game process is gone");
});

test("a game that ignores quit is killed after the grace period, and the result says so", async () => {
  const { game, out } = tempGame();
  const r = await capture({ ...base(game, out), env: { FAKE_MODE: "ignore-quit" }, mode: { kind: "ticks", ticks: [50] } });
  assert.equal(r.shots.length, 1);
  assert.equal(r.exit.killed, true);
  assert.match(r.notes.join(" "), /did not exit after quit; killed/);
  assert.equal(alive(Number(readFileSync(path.join(game, "qa", "pid"), "utf8"))), false);
});

test("R16-1: a leftover ready ack from an earlier run does not pass for a slow-starting game", async () => {
  const { game, out } = tempGame();
  mkdirSync(path.join(game, "qa"), { recursive: true });
  writeFileSync(path.join(game, "qa", "ack.json"), JSON.stringify({ id: 0, ok: true, ready: true }));
  writeFileSync(path.join(game, "qa", "control.json"), JSON.stringify({ id: 0, cmd: "noop" }));
  const t0 = Date.now();
  const r = await capture({ ...base(game, out), timeoutMs: 8000, env: { FAKE_STARTUP_MS: "1000" }, mode: { kind: "ticks", ticks: [40, 90] } });
  assert.deepEqual(r.shots.map((s) => s.tick), [40, 90]);
  assert.ok(Date.now() - t0 >= 1000, "capture waited for the real (post-boot) ready ack");
});

test("R16-1: movie footage, then stills, in the same clone (the trailer workflow)", { skip: NO_FF }, async () => {
  const { root, game, out } = tempGame();
  await capture({ ...base(game, out), env: { FAKE_FFMPEG: FFMPEG(), FAKE_STARTUP_MS: "300" }, mode: { kind: "movie", file: path.join(root, "media", "m", "footage.avi"), exit_after_ticks: 60 } });
  // movie mode sends no commands, so it leaves {id:0, ready:true} behind
  assert.equal(JSON.parse(readFileSync(path.join(game, "qa", "ack.json"), "utf8")).ready, true);
  const r = await capture({ ...base(game, out), env: { FAKE_STARTUP_MS: "300" }, mode: { kind: "ticks", ticks: [25] } });
  assert.deepEqual(r.shots.map((s) => s.tick), [25]);
});

test("a launch that cannot start fails loudly", async () => {
  const { game, out } = tempGame();
  await assert.rejects(capture({ ...base(game, out), launch: [path.join(game, "no-such-binary")], mode: { kind: "ticks", ticks: [1] } }), /could not start the game|ENOENT|exited/);
});

test("movie mode: --write-movie + --exit-after-ticks, waits for the exit, returns the file", { skip: NO_FF }, async () => {
  const { root, game, out } = tempGame();
  const file = path.join(root, "media", "m", "footage.avi");
  const r = await capture({ ...base(game, out), env: { FAKE_FFMPEG: FFMPEG() }, mode: { kind: "movie", file, exit_after_ticks: 80 } });
  assert.equal(r.movie?.file, file);
  assert.ok((r.movie?.bytes ?? 0) > 0);
  assert.equal(r.exit.killed, false);
  const p = await probe(file);
  assert.deepEqual([p.video?.width, p.video?.height], [64, 36]);
  const argv = JSON.parse(readFileSync(path.join(game, "qa", "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(0, 2), ["--write-movie", file]);
  assert.ok(argv.includes("--exit-after-ticks"));
});

// ---- edit plans (ffmpeg) ----

function synthetic(root: string): { video: string; title: string } {
  const media = path.join(root, "media");
  mkdirSync(media, { recursive: true });
  const video = path.join(media, "src.mp4");
  execFileSync(FFMPEG(), ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-t", "2", "-pix_fmt", "yuv420p", video]);
  const img = makeImage(32, 24);
  for (let i = 0; i < 32 * 24; i++) img.data.set([200, 30, 30, 255], i * 4);
  const title = path.join(media, "title.png");
  writeFileSync(title, encodePng(img));
  return { video, title };
}
const confined = (root: string) => ({
  resolveInput: (rel: string) => path.join(root, rel),
  resolveOutput: (rel: string) => path.join(root, rel),
  timeoutMs: 60_000,
});

test("edit: cut + title card → mp4 (H.264 yuv420p) at the planned size, fps, and length", { skip: NO_FF }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-edit-"));
  synthetic(root);
  const r = await edit({ schema_version: 1, clips: [{ still: "media/title.png", duration_s: 1 }, { source: "media/src.mp4", start_s: 0.5, end_s: 1.5 }], output: { path: "media/out/trailer.mp4", format: "mp4", width: 128, height: 96, fps: 10 } }, confined(root));
  assert.equal(r.probe.video?.codec, "h264");
  assert.equal(r.probe.video?.pix_fmt, "yuv420p");
  assert.deepEqual([r.probe.video?.width, r.probe.video?.height], [128, 96]);
  assert.equal(r.probe.video?.fps, 10);
  assert.ok(Math.abs(r.duration_s - 2) < 0.15, `duration ${r.duration_s}`);
  assert.equal(r.probe.audio, false);
  assert.ok(existsSync(path.join(root, "media/out/trailer.mp4")));
});

test("edit: GIF via palettegen/paletteuse, nearest-neighbour scaled", { skip: NO_FF }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-edit-"));
  synthetic(root);
  const r = await edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 0, end_s: 1 }], output: { path: "media/loop.gif", format: "gif", width: 128, height: 96, fps: 5 } }, confined(root));
  assert.equal(r.probe.video?.codec, "gif");
  assert.deepEqual([r.probe.video?.width, r.probe.video?.height], [128, 96]);
  // nearest-neighbour: a solid-colour still upscaled 4× stays one colour (no blended edge pixels)
  const still = await edit({ schema_version: 1, clips: [{ still: "media/title.png", duration_s: 0.4 }], output: { path: "media/still.gif", format: "gif", width: 128, height: 96, fps: 5 } }, confined(root));
  const frame = path.join(root, "frame.png");
  execFileSync(FFMPEG(), ["-y", "-v", "error", "-i", still.out, "-frames:v", "1", frame]);
  const img = decodePng(new Uint8Array(readFileSync(frame)));
  const colours = new Set<string>();
  for (let i = 0; i < img.width * img.height; i++) colours.add(Array.from(img.data.slice(i * 4, i * 4 + 3)).join(","));
  assert.equal(colours.size, 1, `expected one colour, got ${[...colours].slice(0, 5).join(" | ")}`);
});

test("edit: caps and bad plans fail loudly, and nothing is written over a cap", { skip: NO_FF }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-edit-"));
  synthetic(root);
  const out = { path: "media/x.mp4", format: "mp4" as const, width: 64, height: 48, fps: 10 };
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 0, end_s: 1 }], output: { ...out, max_bytes: 100 } }, confined(root)), /over output.max_bytes 100/);
  assert.equal(existsSync(path.join(root, "media/x.mp4")), false);
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 0, end_s: 1.8 }], output: { ...out, max_duration_s: 1 } }, confined(root)), /over output.max_duration_s/);
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 1, end_s: 9 }], output: out }, confined(root)), /past the end/);
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 1, end_s: 1 }], output: out }, confined(root)), /end_s must be after start_s/);
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 0, end_s: 1 }], output: { ...out, width: 63 } }, confined(root)), /even width/);
  await assert.rejects(edit({ schema_version: 1, clips: [{ source: "media/src.mp4", start_s: 0, end_s: 1 }], output: { ...out, path: "media/x.gif" } }, confined(root)), /must end in \.mp4/);
  await assert.rejects(edit({ schema_version: 2, clips: [], output: out }, confined(root)));
});

// ---- the media_capture capability: confinement ----

test("capability: launch/policy/output confinement, capture into media/<name>/, probe and edit through the workspace", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "media-cap-"));
  const game = path.join(ws, "game");
  mkdirSync(game, { recursive: true });
  copyFileSync(FAKE, path.join(game, "fake-game.mjs"));
  chmodSync(path.join(game, "fake-game.mjs"), 0o755);
  writeFileSync(path.join(game, "trailer.jsonl"), "");
  const ctx = { workspace: ws, naive: null };
  const t = IMPLS.media_capture;
  const call = (i: Record<string, unknown>) => t.media_capture.run(t.media_capture.input.parse({ name: "run1", mode: "ticks", ticks: [30], launch: ["fake-game.mjs"], seed: 1, policy: "script:trailer.jsonl", width: 64, height: 64, timeout_s: 10, ...i }), ctx);

  const ok = await call({});
  assert.equal(ok.is_error, undefined, ok.content);
  const res = JSON.parse(ok.content);
  assert.deepEqual(res.shots.map((s: { file: string; tick: number }) => [s.file, s.tick]), [["media/run1/shot-000030-1.png", 30]]);

  assert.match((await call({ launch: ["/bin/sh", "-c", "echo pwned"] })).content, /escapes the workspace/);
  assert.match((await call({ launch: ["sh", "-c", "echo pwned"] })).content, /inside the game clone or the engine/);
  assert.match((await call({ launch: ["../outside"] })).content, /escapes/);
  assert.match((await call({ policy: "script:missing.jsonl" })).content, /does not exist/);
  assert.match((await call({ policy: "script:../../etc/passwd" })).content, /escapes/);
  assert.match((await call({ mode: "movie" })).content, /exit_after_ticks/);
  assert.throws(() => t.media_capture.input.parse({ name: "../x", mode: "ticks", launch: ["a"], seed: 1, policy: "random" }));

  writeFileSync(path.join(ws, "plan.json"), JSON.stringify({ schema_version: 1, clips: [{ still: "media/run1/shot-000030-1.png", duration_s: 0.5 }], output: { path: "elsewhere/x.gif", format: "gif", width: 64, height: 64, fps: 5 } }));
  assert.match((await t.media_edit.run({ plan: "plan.json" }, ctx)).content, /outputs go under media\//);
  writeFileSync(path.join(ws, "plan.json"), JSON.stringify({ schema_version: 1, clips: [{ still: "media/run1/shot-000030-1.png", duration_s: 0.5 }], output: { path: "media/../../x.gif", format: "gif", width: 64, height: 64, fps: 5 } }));
  assert.match((await t.media_edit.run({ plan: "plan.json" }, ctx)).content, /outputs go under media\/|escapes/);
  assert.match((await t.media_probe.run({ path: "../x.mp4" }, ctx)).content, /escapes/);

  if (FF) {
    writeFileSync(path.join(ws, "plan.json"), JSON.stringify({ schema_version: 1, clips: [{ still: "media/run1/shot-000030-1.png", duration_s: 0.5 }], output: { path: "media/run1/card.gif", format: "gif", width: 128, height: 128, fps: 5 } }));
    const e = await t.media_edit.run({ plan: "plan.json" }, ctx);
    assert.equal(e.is_error, undefined, e.content);
    assert.equal(JSON.parse(e.content).out, "media/run1/card.gif");
    const p = JSON.parse((await t.media_probe.run({ path: "media/run1/card.gif" }, ctx)).content);
    assert.equal(p.video.codec, "gif");
  }
});
