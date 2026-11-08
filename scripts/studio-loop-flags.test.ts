// R20: --max-parallel / --poll-s must be integers >= 1 (NaN meant unbounded parallel runs and a hot poll loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "studio-loop.ts");

for (const args of [["--max-parallel", "two"], ["--max-parallel", "0"], ["--poll-s", "abc"], ["--poll-s", "0.5"]]) {
  test(`studio loop refuses ${args.join(" ")}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-flags-"));
    const env = { ...process.env, STUDIO_RUNS_DIR: dir, STUDIO_BOARD_FILE: path.join(dir, "board.jsonl"), STUDIO_LEDGER_FILE: path.join(dir, "ledger.jsonl"), STUDIO_APPROVALS_FILE: path.join(dir, "approvals.jsonl"), NAIVE_API_KEY: "" };
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--once", ...args], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`${args[0]} must be an integer >= 1`));
  });
}
