// TEST DOUBLE — fake contract emulator, not a game. Speaks docs/contracts/controls.md faithfully:
//   startup: clear outputs, control {id:0,noop}, then ack {id:0,ok,ready} (the ready signal);
//   control.json polled every frame, id compare; ack written only after the command FINISHED
//   (step: after N frames, paused again); state.json written only on dump_state, at the end, or on crash;
//   all writes atomic (temp + rename); the run ends on its own at --exit-after-ticks (run_end + run_summary,
//   final dump, exit 0) and commands arriving after that are never acked.
// Modes (env QA_EMULATOR_MODE): happy | crash-mid | negative-resource | softlock | flaky-summary |
//   nondeterministic | slow-ack | exit-nonzero | ignore-sigterm | slow-start | float-resource
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const mode = process.env.QA_EMULATOR_MODE ?? "happy";
const seed = Number(arg("seed", "1"));
const exitAfter = Number(arg("exit-after-ticks", "60"));
const autoplay = process.argv.includes("--autoplay");
const qa = path.join(process.cwd(), "qa");
const half = Math.floor(exitAfter / 2);
if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000); // never exits on its own after run_end: only SIGKILL ends it
}

let tick = 0;
let paused = !autoplay;
let stepLeft = 0;
let stepId = null;
let lastId = 0;
let over = false;
let entities = 0;
let frozen = null; // softlock: state frozen while ticks advance
const resources = { gold: 0 };
const counts = {};

function atomic(file, content) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
function emit(event, data) {
  counts[event] = (counts[event] ?? 0) + 1;
  appendFileSync(path.join(qa, "events.jsonl"), JSON.stringify({ schema_version: 1, tick, event, data }) + "\n");
}
function snapshot() {
  const live = {
    scene: "run",
    // nondeterministic: the system RNG leaks into state. 1e9 values, so two runs collide ~1e-9 of the
    // time (1000 values collided 1 run in 1000 and made the determinism tests flaky, T25)
    player: { x: mode === "nondeterministic" ? tick + Math.floor(Math.random() * 1e9) : tick, y: 0, hp: 3 },
    resources: { ...resources, ...(mode === "float-resource" ? { gold: resources.gold + 0.5 } : {}) },
    entities: Array.from({ length: entities }, (_, i) => ({ id: `e${i}`, type: "slime", x: i, y: 0, w: 8, h: 8 })),
  };
  const body = mode === "softlock" && frozen ? frozen : live;
  return {
    schema_version: 1,
    tick,
    run: { started: true, over, seed, elapsed_ticks: tick },
    ...body,
    errors: [],
  };
}
function dump(extra = {}) {
  atomic(path.join(qa, "state.json"), JSON.stringify({ ...snapshot(), ...extra }));
}
function ack(id, ok, extra = {}) {
  const write = () => atomic(path.join(qa, "ack.json"), JSON.stringify({ id, ok, ...extra }));
  if (mode === "slow-ack" && id !== 0) setTimeout(write, 3_000);
  else write();
}
function finish(outcome) {
  over = true;
  emit("run_end", { outcome });
  const c = { ...counts };
  if (mode === "flaky-summary") c.spawn = (c.spawn ?? 0) + 1; // lies vs events.jsonl
  atomic(
    path.join(qa, "run_summary.json"),
    JSON.stringify({
      schema_version: 1,
      build_id: "test-emulator",
      seed,
      policy: arg("policy", "random"),
      outcome,
      death_cause: "",
      run_ticks: tick,
      elapsed_s: tick / 60,
      picks: [],
      counts: c,
      peaks: { entities, resources: { gold: resources.gold } },
    }),
  );
  dump();
  clearInterval(frames);
  if (mode !== "ignore-sigterm") process.exit(mode === "exit-nonzero" ? 3 : 0);
}

function frame() {
  tick++;
  if (tick % 10 === 1 && entities < 5) {
    emit("spawn", { id: `e${entities}`, type: "slime", x: 0, y: 0 });
    entities++;
  }
  if (tick % 7 === 0) {
    resources.gold += 2;
    emit("pickup", { item: "gold", count: 2 });
  }
  if (mode === "negative-resource" && tick === half) resources.gold = -5;
  if (mode === "softlock" && tick === half) frozen = (({ scene, player, resources: r, entities: e }) => ({ scene, player, resources: r, entities: e }))(snapshot());
  if (mode === "crash-mid" && tick === half) {
    emit("error", { message: "boom" });
    dump({ crashed: true, errors: [{ tick, message: "boom" }] });
    process.exit(3);
  }
  if (tick >= exitAfter) finish(mode === "softlock" ? "quit" : "win");
}

function poll() {
  let c;
  try {
    c = JSON.parse(readFileSync(path.join(qa, "control.json"), "utf8"));
  } catch {
    return;
  }
  if (!c || typeof c.id !== "number" || c.id === lastId) return;
  lastId = c.id;
  switch (c.cmd) {
    case "pause": paused = true; ack(c.id, true); break;
    case "resume": paused = false; ack(c.id, true); break;
    case "step":
      if (!paused) { ack(c.id, false, { error: "already running" }); break; }
      stepLeft = c.frames ?? 0;
      stepId = c.id; // acked once the frames have run (ack = command finished)
      break;
    case "dump_state": dump(); ack(c.id, true, { path: path.join(qa, "state.json") }); break;
    case "screenshot": ack(c.id, true, { path: c.path ?? path.join(qa, `shot-${tick}.png`) }); break;
    case "quit": finish("quit"); break;
    default: ack(c.id, false, { error: `unknown cmd ${c.cmd}` });
  }
}

function startup() {
  mkdirSync(qa, { recursive: true });
  writeFileSync(path.join(qa, "events.jsonl"), "");
  for (const f of ["state.json", "run_summary.json"]) rmSync(path.join(qa, f), { force: true });
  for (const f of readdirSync(qa)) if (/^shot-.*\.png$/.test(f)) rmSync(path.join(qa, f), { force: true });
  atomic(path.join(qa, "control.json"), JSON.stringify({ id: 0, cmd: "noop" }));
  ack(0, true, { ready: true });
  emit("run_start", { seed });
}

let frames;
function start() {
  startup();
  frames = setInterval(() => {
    poll();
    if (over) return;
    if (!paused) frame();
    else if (stepLeft > 0) {
      frame();
      if (over) return;
      if (--stepLeft === 0) ack(stepId, true);
    }
  }, 1);
}

if (mode === "slow-start") setTimeout(start, 300);
else start();
