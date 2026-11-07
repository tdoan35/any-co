import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, waitReady } from "./driver.ts";
import { firstDifference, runInvariants, validateValue, type RunFiles } from "./invariants.ts";
import { CLI_DEFAULTS, check, determinism, smoke, type Cli, type QaResult } from "./qa.ts";

// The fake game is a separate Node process (test double, tools/qa/test/emulator.mjs); mode via env.
const EMULATOR = path.join(import.meta.dirname, "test", "emulator.mjs");
const SCHEMA = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "contracts", "state.schema.json"), "utf8"));

function gameDir(): string {
  return mkdtempSync(path.join(tmpdir(), "qa-game-"));
}

/** A throwaway child program as a file: `node -e` would reject the contract flags appended to argv. */
function script(dir: string, code: string): string {
  const file = path.join(dir, `child-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(file, code);
  return file;
}

function cli(dir: string, over: Partial<Cli> = {}): Cli {
  return {
    ...CLI_DEFAULTS,
    sub: "smoke",
    cmd: JSON.stringify(["node", EMULATOR]),
    dir,
    seed: 7,
    ticks: 40,
    ackTimeoutMs: 2_000,
    readyTimeoutMs: 5_000,
    endWaitMs: 3_000,
    ...over,
  };
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.QA_EMULATOR_MODE;
  process.env.QA_EMULATOR_MODE = mode; // inherited by the spawned emulator
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.QA_EMULATOR_MODE;
    else process.env.QA_EMULATOR_MODE = prev;
  }
}

const failed = (r: QaResult) => (r.checks ?? []).filter((c) => !c.pass).map((c) => c.name);
const checkOf = (r: QaResult, name: string) => r.checks!.find((c) => c.name === name)!;

test("happy run: ready handshake, stepped dumps, every invariant passes, exit 0", async () => {
  const r = await withMode("happy", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 0, JSON.stringify(r, null, 2));
  assert.deepEqual(failed(r), []);
  // D4: dump_state per step chunk → softlock check has data from the running phase
  assert.match(checkOf(r, "no_softlock").detail, /^([2-9]|\d\d+) dump\(s\) while running/);
});

test("D1: a slow-starting game is not sent commands before its ready ack", async () => {
  // slow-start writes control {id:0,noop} 300ms late; a command written before that would be erased
  const r = await withMode("slow-start", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(checkOf(r, "no_softlock").detail, /^([2-9]|\d\d+) dump\(s\) while running/);
});

test("D1: no ready ack in time is a harness error (exit 2)", async () => {
  const dir = gameDir();
  // a process that never speaks the protocol
  const r = await smoke(cli(dir, { cmd: JSON.stringify(["node", script(dir, "setTimeout(()=>{}, 5000)")]), readyTimeoutMs: 300 }));
  assert.equal(r.exitCode, 2, JSON.stringify(r));
  assert.match(r.error!, /ready timeout/);
});

test("D2: stale qa/ files from an earlier run are removed before launch", async () => {
  const dir = gameDir();
  await withMode("happy", () => smoke(cli(dir))); // leaves a full clean run in qa/
  assert.ok(existsSync(path.join(dir, "qa", "run_summary.json")));
  // a "game" that exits 0 without writing anything must not inherit the earlier verdict
  const r = await smoke(cli(dir, { cmd: JSON.stringify(["node", script(dir, "process.exit(0)")]), readyTimeoutMs: 1_000 }));
  assert.notEqual(r.exitCode, 0, JSON.stringify(r));
  assert.ok(!existsSync(path.join(dir, "qa", "run_summary.json")));
  assert.ok(!existsSync(path.join(dir, "qa", "events.jsonl")));
});

test("D3: a non-zero exit fails smoke even when every file invariant passes", async () => {
  const r = await withMode("exit-nonzero", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 1, JSON.stringify(r));
  assert.deepEqual(failed(r), ["process_exit_clean"]);
  assert.match(checkOf(r, "process_exit_clean").detail, /code=3/);
});

test("crash mid-run: error event, crashed dump, no run_end, unclean exit -> exit 1", async () => {
  const r = await withMode("crash-mid", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 1, JSON.stringify(r));
  for (const name of ["no_errors", "run_completes", "process_exit_clean"]) assert.ok(failed(r).includes(name), `${name} should fail: ${failed(r)}`);
  assert.equal(r.end!.code, 3);
});

test("negative resource is caught by both the resource and the schema check", async () => {
  const r = await withMode("negative-resource", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 1);
  assert.match(checkOf(r, "resources_non_negative").detail, /gold=-/);
  assert.match(checkOf(r, "state_matches_schema").detail, /below minimum 0/);
});

test("D5: softlock with ticks still advancing (state frozen) fails no_softlock", async () => {
  const r = await withMode("softlock", () => smoke(cli(gameDir())));
  assert.equal(r.exitCode, 1, JSON.stringify(r));
  assert.deepEqual(failed(r), ["no_softlock"]);
  assert.match(checkOf(r, "no_softlock").detail, /max identical consecutive \(ticks ignored\)=([3-9]|\d\d)/);
});

test("D5: ticks that stop advancing between running dumps fail no_softlock", () => {
  const dump = (tick: number) => ({ tick, run: { over: false }, player: { x: tick } });
  const checks = runInvariants({ states: [dump(5), dump(10), dump(10)], finalState: dump(10), events: [], runSummary: null });
  const c = checks.find((x) => x.name === "no_softlock")!;
  assert.equal(c.pass, false);
  assert.match(c.detail, /stalled at dump 2 \(10 -> 10\)/);
});

test("D6: validator applies additionalProperties/required to objects without properties", () => {
  const resources = SCHEMA.properties.resources;
  assert.deepEqual(validateValue(resources, { gold: 3 }, "$"), []);
  assert.match(validateValue(resources, { gold: 1.5 }, "$").join(), /expected type integer/);
  assert.match(validateValue(resources, { gold: "lots" }, "$").join(), /expected type integer/);
  assert.match(validateValue(resources, { gold: -3 }, "$").join(), /below minimum 0/);
  assert.throws(() => validateValue({ type: "object", oneOf: [] }, {}, "$"), /unsupported schema keyword "oneOf"/);
});

test("D6: a float resource from the game fails state_matches_schema", async () => {
  const r = await withMode("float-resource", () => smoke(cli(gameDir())));
  assert.deepEqual(failed(r), ["state_matches_schema"]);
});

test("D7: schema_version is checked on events and run_summary, standard event data keys are required", () => {
  const state = { schema_version: 1, tick: 1, run: { over: true } };
  const files: RunFiles = {
    states: [state],
    finalState: state,
    events: [
      { schema_version: 2, tick: 0, event: "run_start", data: { seed: 1 } },
      { schema_version: 1, tick: 1, event: "spawn", data: { id: "e0", type: "slime", x: 0 } },
    ],
    runSummary: { schema_version: 1 },
  };
  const checks = runInvariants(files);
  assert.match(checks.find((c) => c.name === "schema_version_known")!.detail, /event\[0\]=2/);
  assert.match(checks.find((c) => c.name === "event_data_keys")!.detail, /event\[1\] spawn\.data\.y/);
  const noSummary = runInvariants({ ...files, runSummary: null });
  assert.match(noSummary.find((c) => c.name === "schema_version_known")!.detail, /run_summary missing/);
});

test("D7: tick rate is an option for elapsed_s", () => {
  const files: RunFiles = { states: [], finalState: null, events: [], runSummary: { run_ticks: 300, elapsed_s: 10 } };
  const at = (tickRate: number) => runInvariants(files, { tickRate }).find((c) => c.name === "telemetry_elapsed_matches_ticks")!;
  assert.equal(at(30).pass, true);
  assert.equal(at(60).pass, false);
});

test("D8: non-standard event names are tallied and flagged, not reported as 'vs events 0'", () => {
  const ev = (event: string) => ({ schema_version: 1, tick: 1, event, data: {} });
  const files: RunFiles = {
    states: [],
    finalState: null,
    events: [ev("tick"), ev("tick"), ev("pickup")],
    runSummary: { counts: { tick: 2, pickup: 1 } },
  };
  const checks = runInvariants(files);
  assert.equal(checks.find((c) => c.name === "telemetry_counts_match")!.pass, true);
  const ns = checks.find((c) => c.name === "telemetry_counts_standard_only")!;
  assert.equal(ns.pass, false);
  assert.match(ns.detail, /tick=2 \(events 2\)/);
});

test("telemetry mismatch on a standard event fails counts", async () => {
  const r = await withMode("flaky-summary", () => smoke(cli(gameDir())));
  assert.deepEqual(failed(r), ["telemetry_counts_match"]);
  const [, claimed, actual] = /spawn: summary (\d+) vs events (\d+)/.exec(checkOf(r, "telemetry_counts_match").detail)!;
  assert.equal(Number(claimed), Number(actual) + 1);
});

test("D9: a game ignoring SIGTERM is SIGKILLed and reported as timeout", async () => {
  const r = await withMode("ignore-sigterm", () => smoke(cli(gameDir(), { ackTimeoutMs: 300, endWaitMs: 500 })));
  assert.equal(r.exitCode, 1, JSON.stringify(r));
  assert.equal(r.end!.reason, "timeout");
  assert.equal(r.end!.signal, "SIGKILL");
  assert.equal(r.end!.forced, "kill");
});

test("D9: driver kill escalates to SIGKILL after the grace", async () => {
  const dir = gameDir();
  // child installs its SIGTERM no-op, then signals readiness the contract way (ack id 0)
  const child = "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('qa/ack.json', JSON.stringify({id:0,ok:true,ready:true})); setInterval(()=>{},1000)";
  const d = launch({ cmd: ["node", script(dir, child)], cwd: dir });
  await waitReady(d.qaDir, 5_000);
  const t0 = Date.now();
  d.kill(300);
  const end = await d.done();
  assert.equal(end.signal, "SIGKILL");
  assert.ok(Date.now() - t0 < 3_000);
});

test("ack timeout on a live game is a harness error (exit 2)", async () => {
  const r = await withMode("slow-ack", () => smoke(cli(gameDir(), { ackTimeoutMs: 300 })));
  assert.equal(r.exitCode, 2, JSON.stringify(r));
  assert.match(r.error!, /ack timeout: no ack with id 1/);
});

test("D10: step acks only after the frames ran (ack = finished), so back-to-back steps never hit 'already running'", async () => {
  const dir = gameDir();
  const d = await withMode("happy", async () => {
    const drv = launch({ cmd: ["node", EMULATOR], cwd: dir, seed: 1, autoplay: true, "exit-after-ticks": 1000 });
    await waitReady(drv.qaDir, 5_000);
    return drv;
  });
  assert.equal((await d.send({ cmd: "pause" })).ok, true);
  for (let i = 0; i < 5; i++) assert.equal((await d.send({ cmd: "step", frames: 7 })).ok, true);
  assert.equal((await d.send({ cmd: "dump_state" })).ok, true);
  const s = d.readState() as { tick: number };
  const t0 = s.tick;
  assert.equal((await d.send({ cmd: "step", frames: 10 })).ok, true);
  await d.send({ cmd: "dump_state" });
  assert.equal((d.readState() as { tick: number }).tick, t0 + 10);
  d.kill(200);
  await d.done();
});

test("determinism: a system-RNG emulator is caught with the first differing path", async () => {
  const r = await withMode("nondeterministic", () => determinism(cli(gameDir(), { sub: "determinism" })));
  assert.equal(r.exitCode, 1, JSON.stringify(r));
  assert.match(r.error!, /\$\.player\.x/);
});

test("determinism: a deterministic emulator passes, and the two runs don't share stale files", async () => {
  const r = await withMode("happy", () => determinism(cli(gameDir(), { sub: "determinism" })));
  assert.equal(r.exitCode, 0, JSON.stringify(r));
});

test("D9: determinism reports exit codes when a run ends uncleanly", async () => {
  const r = await withMode("exit-nonzero", () => determinism(cli(gameDir(), { sub: "determinism" })));
  assert.equal(r.exitCode, 1);
  assert.match(r.error!, /code=3/);
});

test("check: offline invariants over files a real run left", async () => {
  const dir = gameDir();
  await withMode("happy", () => smoke(cli(dir)));
  const r = check({ ...cli(path.join(dir, "qa")), sub: "check" });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
});

test("check: missing files are a harness error (exit 2)", () => {
  const r = check({ ...cli(gameDir()), sub: "check" });
  assert.equal(r.exitCode, 2);
});

test("CLI: exit codes and JSON on stdout", async () => {
  const dir = gameDir();
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "qa.ts"), ...args], {
        env: { ...process.env, ...env },
        cwd: path.join(import.meta.dirname, "..", ".."),
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ code, out }));
    });
  const base = ["smoke", "--cmd", JSON.stringify(["node", EMULATOR]), "--dir", dir, "--seed", "3", "--ticks", "20", "--end-wait-ms", "3000"];
  const ok = await run(base, { QA_EMULATOR_MODE: "happy" });
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.out).ok, true);
  const bad = await run(base, { QA_EMULATOR_MODE: "negative-resource" });
  assert.equal(bad.code, 1);
  const usage = await run(["smoke"], {});
  assert.equal(usage.code, 2);
});

test("firstDifference reports the first path", () => {
  assert.equal(firstDifference({ a: { b: 1 } }, { a: { b: 1 } }), null);
  assert.equal(firstDifference({ a: { b: 1 } }, { a: { b: 2 } }), "$.a.b: 1 vs 2");
  assert.equal(firstDifference({ a: [1, 2] }, { a: [1, 2, 3] }), "$.a (length 2 vs 3)");
});

test("unknown schema_version fails loudly", () => {
  const checks = runInvariants({ states: [{ schema_version: 2 }], finalState: { schema_version: 2 }, events: [], runSummary: null });
  assert.match(checks.find((c) => c.name === "schema_version_known")!.detail, /state\[0\]=2/);
});

