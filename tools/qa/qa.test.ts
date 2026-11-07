import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runInvariants, firstDifference } from "./invariants.ts";

const run = promisify(execFile);
const EMULATOR = path.join(import.meta.dirname, "test", "emulator.mjs");

interface QaJson {
  ok: boolean;
  exitCode: number;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  error?: string;
  end?: { reason: string; code: number | null };
}

async function qa(args: string[], env: Record<string, string> = {}, timeout = 30_000): Promise<{ code: number; out: QaJson }> {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-test-"));
  const tsxLoader = fileURLToPath(await import.meta.resolve?.("tsx") ?? "tsx");
  try {
    const res = await run("node", ["--import", `file://${tsxLoader}`, "tools/qa/qa.ts", ...args], {
      cwd: repoRoot(),
      timeout,
      env: { ...process.env, QA_GAME_DIR: dir, ...env },
    });
    return { code: 0, out: JSON.parse(res.stdout) as QaJson };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; message: string };
    if (typeof err.code === "number" && err.stdout) return { code: err.code, out: JSON.parse(err.stdout) as QaJson };
    throw err;
  }
}

function repoRoot(): string {
  // tools/qa/qa.test.ts -> tools/qa -> tools -> repo root
  return path.resolve(import.meta.dirname, "..", "..");
}

function smokeArgs(dir: string, _mode: string, extra: string[] = []): string[] {
  return [
    "smoke",
    "--cmd",
    JSON.stringify(["node", EMULATOR]),
    "--dir",
    dir,
    "--seed",
    "7",
    "--ticks",
    "40",
    ...extra,
  ];
}

test("happy run passes smoke with all invariants", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  const { code, out } = await qa([...smokeArgs(dir, "happy")], { QA_EMULATOR_MODE: "happy" });
  assert.equal(out.exitCode, 0, JSON.stringify(out, null, 2));
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  const names = out.checks!.map((c) => c.name);
  for (const expected of [
    "schema_version_known",
    "state_matches_schema",
    "no_errors",
    "run_completes",
    "no_softlock",
    "entities_bounded",
    "resources_non_negative",
    "telemetry_counts_match",
    "telemetry_elapsed_matches_ticks",
  ]) {
    assert.ok(names.includes(expected), `missing check ${expected}: ${names.join(",")}`);
  }
  assert.ok(out.checks!.every((c) => c.pass), out.checks!.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join("\n"));
});

test("slow acks do not wedge the run (driver tolerates late acks)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  // emulator acks 10s late but executes instantly; 200ms ack budget exceeds real ack latency
  const { code, out } = await qa([...smokeArgs(dir, "slow-ack"), "--ack-timeout-ms", "200", "--end-wait-ms", "1000"], { QA_EMULATOR_MODE: "slow-ack" }, 15_000);
  assert.equal(out.exitCode, 0, JSON.stringify(out));
  assert.equal(code, 0);
});

test("crash mid-run fails run_completes and no_errors, exit 1", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  const { code, out } = await qa([...smokeArgs(dir, "crash-mid"), "--ack-timeout-ms", "3000"], { QA_EMULATOR_MODE: "crash-mid" });
  assert.equal(out.exitCode, 1, JSON.stringify(out));
  assert.equal(code, 1);
  const noErrors = out.checks!.find((c) => c.name === "no_errors")!;
  assert.equal(noErrors.pass, false, noErrors.detail); // error event present
  const completes = out.checks!.find((c) => c.name === "run_completes")!;
    assert.equal(completes.pass, false, completes.detail); // no run_end
  assert.match(out.end!.reason, /exit/);
  assert.equal(out.end!.code, 3);
});

test("negative resource fails resources_non_negative", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  const { out } = await qa([...smokeArgs(dir, "negative-resource")], { QA_EMULATOR_MODE: "negative-resource" });
  const r = out.checks!.find((c) => c.name === "resources_non_negative")!;
  assert.equal(r.pass, false, r.detail);
  assert.match(r.detail, /gold=-/);
});

test("softlocked run fails no_softlock with identical-dump count", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  // driver's run-end wait would hang on a softlocked game; bound the whole thing via the emulator quit
  // softlock mode stalls at tick 20 of 40 with run.over false: kill via shorter run: ticks 25 and rely on quit
  const { code, out } = await qa([...smokeArgs(dir, "softlock"), "--ack-timeout-ms", "2000", "--end-wait-ms", "3000"], { QA_EMULATOR_MODE: "softlock" }, 20_000);
  const s = out.checks!.find((c) => c.name === "no_softlock")!;
    assert.equal(s.pass, false, s.detail);
  assert.match(s.detail, /identical/);
});

test("telemetry mismatch fails counts check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  const { out } = await qa([...smokeArgs(dir, "flaky-summary")], { QA_EMULATOR_MODE: "flaky-summary" });
  const c = out.checks!.find((c2) => c2.name === "telemetry_counts_match")!;
  assert.equal(c.pass, false, c.detail);
  assert.match(c.detail, /spawn/);
});

test("determinism catches a nondeterministic emulator via differing final states", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  // run the two runs by hand against the same dir so the emulator's system-RNG differs
  const args = ["determinism", "--cmd", JSON.stringify(["node", EMULATOR]), "--dir", dir, "--seed", "7", "--ticks", "40"];
  const { code, out } = await qa(args, { QA_EMULATOR_MODE: "nondeterministic" });
  assert.equal(out.exitCode, 1, JSON.stringify(out));
  assert.equal(code, 1);
  assert.match(out.error!, /\$\.player\.x/);
});

test("determinism passes for a deterministic emulator", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-game-"));
  const args = ["determinism", "--cmd", JSON.stringify(["node", EMULATOR]), "--dir", dir, "--seed", "7", "--ticks", "40"];
  const { out } = await qa(args, { QA_EMULATOR_MODE: "happy" });
  assert.equal(out.exitCode, 0, JSON.stringify(out));
});

test("firstDifference reports the first path", () => {
  assert.equal(firstDifference({ a: { b: 1 } }, { a: { b: 1 } }), null);
  assert.equal(firstDifference({ a: { b: 1 } }, { a: { b: 2 } }), "$.a.b: 1 vs 2");
  assert.equal(firstDifference({ a: [1, 2] }, { a: [1, 2, 3] }), "$.a (length 2 vs 3)");
  assert.equal(firstDifference(1, "x"), "$: 1 vs \"x\"");
});

test("check mode runs invariants over existing files offline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-offline-"));
  // produce files via one emulator run, then run `check`
  await run("node", [EMULATOR, "--exit-after-ticks", "20"], { cwd: dir, env: { ...process.env, QA_EMULATOR_MODE: "happy" }, timeout: 10_000 });
  const { code, out } = await run("node", ["--import", "tsx", "tools/qa/qa.ts", "check", "--dir", path.join(dir, "qa")], {
    cwd: repoRoot(),
    timeout: 10_000,
    env: process.env,
  }).then(
    (r) => ({ code: 0, out: JSON.parse(r.stdout) as QaJson }),
    (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, out: JSON.parse(e.stdout ?? "{}") as QaJson }),
  );
  assert.equal(out.exitCode, 0, JSON.stringify(out));
  assert.equal(code, 0);
  assert.ok(out.checks!.length > 0);
});

test("invariants unit: unknown schema_version fails loudly", () => {
  const checks = runInvariants(
    { states: [{ schema_version: 2 }], finalState: { schema_version: 2 }, events: [], runSummary: null },
    {},
  );
  const v = checks.find((c) => c.name === "schema_version_known")!;
  assert.equal(v.pass, false);
  assert.match(v.detail, /2/);
});
