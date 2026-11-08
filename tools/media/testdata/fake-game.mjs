#!/usr/bin/env node
// Test double for tools/media: a fake "desktop build" that speaks the qa/ protocol from
// docs/contracts (controls, events, screenshot, state-dump) with no game in it. It ticks on a
// timer, emits standard events on a fixed schedule, and writes solid-colour PNGs on screenshot.
// FAKE_MODE=no-ready never acks startup; FAKE_MODE=ignore-quit acks quit but keeps running;
// FAKE_STARTUP_MS delays startup like a real engine boot. FAKE_MODE=quit-at-run-end exits when the run ends (tick 400),
// as a real game driver does on a win or loss.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = process.env.FAKE_MODE ?? "normal";
const [W, H] = (flag("--resolution") ?? "64x36").split("x").map(Number);
const exitAfter = flag("--exit-after-ticks") ? Number(flag("--exit-after-ticks")) : null;
const movie = flag("--write-movie");
const scale = Number(flag("--time-scale") ?? "1");

// FAKE_STARTUP_MS: engine boot time before the game touches qa/ (Godot takes ~1 s).
const startupMs = Number(process.env.FAKE_STARTUP_MS ?? "0");
if (startupMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupMs);
const qa = "qa";
mkdirSync(qa, { recursive: true });
const atomic = (file, text) => {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
};
writeFileSync(path.join(qa, "events.jsonl"), "");
rmSync(path.join(qa, "state.json"), { force: true });
writeFileSync(path.join(qa, "argv.json"), JSON.stringify(args));
writeFileSync(path.join(qa, "pid"), String(process.pid));
atomic(path.join(qa, "control.json"), JSON.stringify({ id: 0, cmd: "noop" }));
if (mode !== "no-ready") atomic(path.join(qa, "ack.json"), JSON.stringify({ id: 0, ok: true, ready: true }));

// ---- tiny PNG encoder (8-bit RGBA, filter 0) ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(rgba).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- simulation ----
let tick = 0;
let paused = false;
let lastId = 0;
let over = false;
const emit = (event, data) => appendFileSync(path.join(qa, "events.jsonl"), JSON.stringify({ schema_version: 1, tick, event, data }) + "\n");
const advance = () => {
  tick++;
  if (tick === 1) emit("run_start", { seed: Number(flag("--seed") ?? 0) });
  if (tick % 100 === 0) emit("wave", { wave: tick / 100 });
  if (tick === 250) emit("death", { target: "player", cause: "test" });
  if (tick === 400) {
    emit("run_end", { outcome: "loss" });
    over = true;
    if (mode === "quit-at-run-end") finish();
  }
};
const dump = () => atomic(path.join(qa, "state.json"), JSON.stringify({ schema_version: 1, scene: "run", tick, run: { started: true, over, seed: 0, elapsed_ticks: tick }, player: { x: 0, y: 0 }, resources: {}, entities: [], errors: [] }));
const finish = () => {
  dump();
  atomic(path.join(qa, "run_summary.json"), JSON.stringify({ schema_version: 1, ticks: tick }));
  if (movie) {
    if (process.env.FAKE_FFMPEG) execFileSync(process.env.FAKE_FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=10`, "-t", "1", "-c:v", "mjpeg", movie]);
    else writeFileSync(movie, "fake movie");
  }
  process.exit(0);
};

setInterval(() => {
  if (!paused) for (let i = 0; i < Math.max(1, Math.round(scale)); i++) advance();
  if (exitAfter !== null && tick >= exitAfter) finish();
  let cmd;
  try {
    cmd = JSON.parse(readFileSync(path.join(qa, "control.json"), "utf8"));
  } catch {
    return;
  }
  if (!cmd || cmd.id === lastId || mode === "no-ready") return;
  lastId = cmd.id;
  const ack = (extra = {}) => atomic(path.join(qa, "ack.json"), JSON.stringify({ id: cmd.id, ok: true, ...extra }));
  const nack = (error) => atomic(path.join(qa, "ack.json"), JSON.stringify({ id: cmd.id, ok: false, error }));
  switch (cmd.cmd) {
    case "pause": paused = true; return ack();
    case "resume": paused = false; return ack();
    case "step":
      if (!paused) return nack("already running");
      for (let i = 0; i < cmd.frames; i++) advance();
      return ack();
    case "dump_state": dump(); return ack({ path: path.resolve(qa, "state.json") });
    case "screenshot": {
      const p = cmd.path ?? `qa/shot-${tick}.png`;
      writeFileSync(`${p}.tmp`, png(W, H, [tick % 256, 40, 80, 255]));
      renameSync(`${p}.tmp`, p);
      appendFileSync(path.join(qa, "shots.jsonl"), JSON.stringify({ path: p, tick }) + "\n");
      return ack({ path: path.resolve(p) });
    }
    case "quit":
      ack();
      if (mode === "ignore-quit") return;
      return finish();
    default: return nack(`unknown command ${cmd.cmd}`);
  }
}, 1);
