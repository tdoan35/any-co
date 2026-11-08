import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS, validateLaunchArgv } from "./impl.ts";

const EMULATOR = path.join(import.meta.dirname, "..", "..", "tools", "qa", "test", "emulator.mjs");
const { qa_smoke, qa_check, qa_determinism } = IMPLS.qa_harness;

/** A fake run workspace whose game clone is a dir holding the emulator as the entry point. */
function workspace(mode: string): { ws: string; clone: string } {
  const ws = mkdtempSync(path.join(tmpdir(), "qa-harness-"));
  const clone = path.join(ws, "game");
  mkdirSync(clone, { recursive: true });
  writeFileSync(path.join(clone, "project.godot"), ""); // the clone marker
  const entry = path.join(clone, "qa-entry.cjs");
  // executable shebang script: the driver spawns argv[0] directly, and the launch binary must
  // live in the clone (contract), so the fake game is an executable, not a node -inline
  writeFileSync(entry, `#!/usr/bin/env node\nprocess.env.QA_EMULATOR_MODE=${JSON.stringify(mode)};\nrequire(${JSON.stringify(EMULATOR)});\n`, { mode: 0o755 });
  return { ws, clone };
}
const ctx = (ws: string) => ({ workspace: ws, naive: null });
// Caps only, never waited on in a passing run: generous so full-suite CPU load can't trip them (T25).
const ACK_MS = 30_000;
const END_MS = 60_000;

test("validateLaunchArgv: godot by name, paths in the clone; rejects shell strings and outside binaries", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "qa-val-"));
  writeFileSync(path.join(clone, "qa-entry.cjs"), "", { mode: 0o755 });
  mkdirSync(path.join(clone, "bin"), { recursive: true });
  writeFileSync(path.join(clone, "bin", "run"), "", { mode: 0o755 });
  assert.deepEqual(validateLaunchArgv(["godot", "--headless", "res://qa/driver.tscn", "--"], clone).length, 4);
  assert.deepEqual(validateLaunchArgv(["./qa-entry.cjs"], clone), ["./qa-entry.cjs"]);
  assert.deepEqual(validateLaunchArgv([path.join(clone, "bin", "run")], clone).length, 1);
  assert.throws(() => validateLaunchArgv("godot --headless", clone), /string\[\] argv/);
  assert.throws(() => validateLaunchArgv(["sh", "-c", "echo hi"], clone), /not found/); // bare name = clone-relative
  assert.throws(() => validateLaunchArgv(["/usr/bin/env"], clone), /inside the clone/);
  assert.throws(() => validateLaunchArgv(["./missing"], clone), /not found/);
});

test("qa_smoke runs the emulator clone end to end: verdict JSON, pass on happy", async () => {
  const { ws } = workspace("happy");
  const r = await qa_smoke.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 40, ack_timeout_ms: ACK_MS, end_wait_ms: END_MS }, ctx(ws));
  const out = JSON.parse(r.content) as { ok: boolean; exitCode: number; checks: unknown[] };
  assert.equal(r.is_error, undefined, r.content);
  assert.equal(out.exitCode, 0, r.content);
  assert.equal(out.ok, true);
  assert.ok(out.checks.length >= 10);
});

test("qa_smoke surfaces invariant failures with names (negative resource)", async () => {
  const { ws } = workspace("negative-resource");
  const r = await qa_smoke.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 40, ack_timeout_ms: ACK_MS, end_wait_ms: END_MS }, ctx(ws));
  const out = JSON.parse(r.content) as { exitCode: number; checks: Array<{ name: string; pass: boolean }> };
  assert.equal(out.exitCode, 1);
  assert.ok(out.checks.some((c) => c.name === "resources_non_negative" && !c.pass));
});

test("qa_smoke without a clone is an error result the agent can read", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "qa-harness-empty-"));
  const r = await qa_smoke.run({ cmd: ["godot", "--version"], seed: 1, ticks: 1 }, ctx(ws));
  assert.equal(r.is_error, true);
  assert.match(r.content, /game_clone first/);
});

test("qa_check grades existing qa/ files inside the clone", async () => {
  const { ws } = workspace("happy");
  await qa_smoke.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 40, ack_timeout_ms: ACK_MS, end_wait_ms: END_MS }, ctx(ws));
  const r = await qa_check.run({}, ctx(ws));
  const out = JSON.parse(r.content) as { exitCode: number };
  assert.equal(out.exitCode, 0, r.content);
});

test("qa_determinism passes for the deterministic emulator and fails with a path for the RNG one", async () => {
  const good = await qa_determinism.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 40, ack_timeout_ms: ACK_MS, end_wait_ms: END_MS }, ctx(workspace("happy").ws));
  assert.equal(JSON.parse(good.content).exitCode, 0, good.content);
  const rng = await qa_determinism.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 40, ack_timeout_ms: ACK_MS, end_wait_ms: END_MS }, ctx(workspace("nondeterministic").ws));
  const out = JSON.parse(rng.content) as { exitCode: number; error?: string };
  assert.equal(out.exitCode, 1);
  assert.match(out.error!, /\$\.player\.x/);
});

test("timeouts are mandatory: absent end_wait gets the 120s default, absurd values rejected", async () => {
  const { ws } = workspace("happy");
  const ok = await qa_smoke.run({ cmd: ["./qa-entry.cjs"], seed: 7, ticks: 20 }, ctx(ws)); // end_wait default applies
  assert.equal(JSON.parse(ok.content).exitCode, 0, ok.content);
  const bad = await qa_smoke.run({ cmd: ["./qa-entry.cjs"], end_wait_ms: -1 }, ctx(ws));
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /non-negative/);
});
