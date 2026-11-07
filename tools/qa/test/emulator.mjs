// TEST DOUBLE — fake contract emulator, not a game. Speaks docs/contracts: qa/control.json polled
// for id changes, qa/ack.json written per command, qa/events.jsonl, qa/state.json, qa/run_summary.json.
// Modes via env QA_EMULATOR_MODE: happy | crash-mid | negative-resource | softlock | flaky-summary | nondeterministic | slow-ack.
// Usage: node emulator.mjs --seed N --exit-after-ticks N ... (flags it understands; ignores the rest).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const mode = process.env.QA_EMULATOR_MODE ?? "happy";
const seed = Number(arg("seed", "1"));
const exitAfter = Number(arg("exit-after-ticks", "60"));
const dir = process.cwd();
const qa = path.join(dir, "qa");
mkdirSync(qa, { recursive: true });

let tick = 0;
let paused = false; // autoplay: the QA smoke always passes --autoplay
let lastId = null;
let entities = 0;
const resources = { gold: 0 };
const events = [];

function emit(event, data) {
  events.push({ schema_version: 1, tick, event, data });
  appendFileSync(path.join(qa, "events.jsonl"), JSON.stringify({ schema_version: 1, tick, event, data }) + "\n");
}

function stateSnapshot() {
  const s = {
    schema_version: 1,
    scene: "run",
    tick,
    run: { started: true, over: tick >= exitAfter, seed, elapsed_ticks: tick },
    player: { x: tick, y: 0, hp: 3 },
    resources: { ...resources },
    entities: Array.from({ length: entities }, (_, i) => ({ id: `e${i}`, type: "slime", x: i, y: 0, w: 8, h: 8 })),
    errors: [],
  };
  if (mode === "nondeterministic" && tick >= exitAfter) {
    s.player.x = tick + Math.floor(Math.random() * 5); // system RNG: breaks determinism
  }
  return s;
}

function writeState() {
  atomic(path.join(qa, "state.json"), JSON.stringify(stateSnapshot()));
}

function atomic(file, content) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function summary() {
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] ?? 0) + 1;
  if (mode === "flaky-summary") counts.spawn = (counts.spawn ?? 0) + 1; // lie vs events.jsonl
  const s = {
    schema_version: 1,
    build_id: "test-emulator",
    seed,
    policy: "greedy",
    outcome: "win",
    death_cause: null,
    run_ticks: tick,
    elapsed_s: tick / 60,
    picks: [],
    counts,
    peaks: { entities, resources: { gold: resources.gold } },
  };
  atomic(path.join(qa, "run_summary.json"), JSON.stringify(s));
}

function ack(id, ok, extra = {}) {
  atomic(path.join(qa, "ack.json"), JSON.stringify({ id, ok, ...extra }));
}

function finish() {
  emit("run_end", { outcome: "win" });
  summary();
  writeState();
  process.exit(0);
}

emit("run_start", { seed });
writeState();

const frames = setInterval(() => {
  if (paused) return;
  const over = stepOnce();
  if (over) {
    clearInterval(frames);
    finish();
  }
}, 2);
let crashed = false;
function crashMid() {
  // crash-mid: die right after half the ticks, no run_end/summary — deterministic, mid-command
  if (mode === "crash-mid" && !crashed && tick >= Math.floor(exitAfter / 2)) {
    crashed = true;
    emit("error", { message: "boom" });
    process.exit(3);
  }
}

function stepOnce() {
  if (mode === "softlock" && tick >= Math.floor(exitAfter / 2)) {
    return false; // stall: tick frozen below exitAfter, run.over stays false -> softlock
  }
  tick++;
  crashMid();
  if (tick % 10 === 1 && entities < 5) {
    entities++;
    emit("spawn", { id: `e${entities - 1}`, type: "slime", x: 0, y: 0 });
  }
  if (tick % 7 === 0) {
    resources.gold += 2;
    emit("pickup", { item: "gold", count: 2 });
  }
  if (mode === "negative-resource" && tick === Math.floor(exitAfter / 2)) {
    resources.gold = -5;
  }
  writeState();
  return tick >= exitAfter;
}

// control loop: poll every frame; id compare, never mtime
const control = path.join(qa, "control.json");
const poll = setInterval(() => {
  if (!existsSync(control)) return;
  let c;
  try {
    c = JSON.parse(readFileSync(control, "utf8"));
  } catch {
    return;
  }
  if (!c || c.id === undefined || c.id === lastId) return;
  lastId = c.id;
  if (mode === "slow-ack") {
    // ack late but still execute: exercises the driver timeout without changing run behavior
    setTimeout(() => ack(c.id, true), 10_000);
  }
  switch (c.cmd) {
    case "pause": paused = true; ack(c.id, true); break;
    case "resume": paused = false; ack(c.id, true); break;
    case "step": {
      if (!paused) { ack(c.id, false, { error: "already running" }); break; }
      let over = false;
      for (let i = 0; i < (c.frames ?? 0); i++) over = stepOnce() || over;
      writeState();
      ack(c.id, true);
      if (over) {
        clearInterval(poll);
        clearInterval(frames);
        finish(); // ack first, then run_end + exit: the harness must see the ack
      }
      break;
    }
    case "dump_state": writeState(); ack(c.id, true, { path: path.join(qa, "state.json") }); break;
    case "screenshot": ack(c.id, true, { path: c.path ?? path.join(qa, "shot.png") }); break;
    case "quit": clearInterval(poll); clearInterval(frames); finish(); break;
    default: ack(c.id, false, { error: `unknown cmd ${c.cmd}` });
  }
}, 2);
