import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// scripts/run-agent.ts flag validation: a bad --approval-timeout-min must exit 2 before any
// provider or run starts (with no keys in env the script would otherwise die later, exit 1).
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-agent.ts");

const run = (flagArgs: string[]) => {
  const { promise, resolve } = Promise.withResolvers<{ code: number | undefined; stderr: string }>();
  const env = { ...process.env };
  delete env.NAIVE_API_KEY;
  execFile(process.execPath, ["--import", "tsx", SCRIPT, "toy-catalog-reporter", "--task", "x", ...flagArgs], { env }, (error, _stdout, stderr) =>
    resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stderr: String(stderr) }));
  return promise;
};

test("run-agent rejects a non-positive or non-numeric --approval-timeout-min with exit 2", async () => {
  // "-5" needs the = form: parse_args reads a leading dash as a missing option value.
  for (const bad of [["--approval-timeout-min", "abc"], ["--approval-timeout-min", "0"], ["--approval-timeout-min=-5"], ["--approval-timeout-min", ""]]) {
    const r = await run(bad);
    assert.equal(r.code, 2, `${bad.join(" ")} should exit 2, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /--approval-timeout-min/);
  }
});
