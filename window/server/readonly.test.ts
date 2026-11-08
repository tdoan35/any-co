// A window can show another folder's runs (STUDIO_RUNS_DIR) and is then read-only: a mirrored runs/ drops writes
// (rsync --delete), and a chat turn there would spend the viewer's key into a ledger copy.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../../runner/load.ts";
import { startServer, windowReadOnly, windowRunsDir } from "./index.ts";

const POST = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("runs dir: opts win, then STUDIO_RUNS_DIR (relative to the repo root), then <repo>/runs", () => {
  assert.deepEqual(windowRunsDir({ runsDir: "/x/runs" }, { STUDIO_RUNS_DIR: "/y" }), { runsDir: "/x/runs", fromEnv: false });
  assert.deepEqual(windowRunsDir({}, { STUDIO_RUNS_DIR: "/Users/a/any-co/runs" }), { runsDir: "/Users/a/any-co/runs", fromEnv: true });
  assert.deepEqual(windowRunsDir({}, { STUDIO_RUNS_DIR: "../mirror/runs" }), { runsDir: path.resolve(ROOT, "../mirror/runs"), fromEnv: true });
  assert.deepEqual(windowRunsDir({}, {}), { runsDir: path.join(ROOT, "runs"), fromEnv: false });
});

test("read-only: explicit flag, env flag, or an env runs dir outside this repo's runs/", () => {
  const own = path.join(ROOT, "runs");
  assert.equal(windowReadOnly({}, own, false, {}), false); // default unchanged
  assert.equal(windowReadOnly({}, own, true, {}), false); // env pointing at our own runs/
  assert.equal(windowReadOnly({}, "/elsewhere/runs", true, {}), true); // mirror implied
  assert.equal(windowReadOnly({}, "/tmp/test-runs", false, {}), false); // opts.runsDir (tests) is not a mirror
  assert.equal(windowReadOnly({}, own, false, { STUDIO_WINDOW_READONLY: "1" }), true);
  assert.equal(windowReadOnly({ readOnly: false }, "/elsewhere/runs", true, { STUDIO_WINDOW_READONLY: "1" }), false);
});

test("a read-only window refuses both chat POSTs with 403 and still serves reads", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "window-ro-"));
  const s = await startServer({ runsDir: dir, port: 0, readOnly: true, ledgerFile: path.join(dir, "ledger.jsonl"), providerFor: () => { throw new Error("must not run"); } });
  try {
    const base = `http://127.0.0.1:${s.port}/api`;
    const a = await fetch(`${base}/sessions`, POST({ agentId: "studio-head" }));
    assert.equal(a.status, 403);
    assert.deepEqual(await a.json(), { error: "read-only window (mirror)" });
    const b = await fetch(`${base}/sessions/s1/messages`, POST({ clientMessageId: "c1", text: "hi" }));
    assert.equal(b.status, 403);
    assert.equal((await fetch(`${base}/runs`)).status, 200);
    assert.equal(s.readOnly, true);
    assert.equal(s.runsDir, dir);
  } finally {
    await s.close();
  }
});
