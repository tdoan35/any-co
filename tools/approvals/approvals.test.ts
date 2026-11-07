import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { request, decide, pending, get, queueApprover } from "./approvals.ts";
import { read as readLedger, type ApprovalEntry, type LedgerEntry } from "../ledger/ledger.ts";

const files = () => {
  const d = mkdtempSync(path.join(tmpdir(), "approvals-"));
  return { f: path.join(d, "approvals.jsonl"), ledger: path.join(d, "ledger.jsonl") };
};
const approvalsOf = (entries: LedgerEntry[]): ApprovalEntry[] => entries.filter((e): e is ApprovalEntry => e.kind === "approval");
const readEventsOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l) as { event: string; ts: string; nonce?: string }]; } catch { return []; }
});

test("request → approve: record approved, pending empties, ledger entry written", () => {
  const { f, ledger } = files();
  const id = request({ agent: "tech-lead", run_id: "run-1", tool: "game_exec", input: { cmd: ["ls"] } }, f);
  assert.match(id, /^apr-\d{14}-[0-9a-f]{4}$/);
  assert.equal(pending(f).length, 1);
  assert.equal(get(id, f)?.state, "pending");

  const rec = decide(id, true, "operator", "looked fine", f, ledger);
  assert.equal(rec?.state, "approved");
  assert.equal(pending(f).length, 0);
  assert.equal(get(id, f)?.state, "approved");

  const [e] = approvalsOf(readLedger(ledger));
  assert.equal(e.decision, "approved");
  assert.equal(e.request_id, id);
  assert.equal(e.agent, "tech-lead");
  assert.equal(e.run_id, "run-1");
  assert.equal(e.tool, "game_exec");
  assert.equal(e.who, "operator");
  assert.equal(e.note, "looked fine");
  assert.equal(e.input_summary, JSON.stringify({ cmd: ["ls"] }));
});

test("request → deny: note recorded on event and ledger entry", () => {
  const { f, ledger } = files();
  const id = request({ agent: "marketing-lead", run_id: "run-2", tool: "outreach_send", input: { to: "x" } }, f);
  const rec = decide(id, false, "operator", "off-brand", f, ledger);
  assert.equal(rec?.state, "denied");
  const [e] = approvalsOf(readLedger(ledger));
  assert.equal(e.decision, "denied");
  assert.equal(e.note, "off-brand");
});

// Deliberate real-clock integration test: expiry is a wall-clock deadline (Date.now + timeoutMs),
// so deterministic timer control would test the mock, not the gate.
test("queueApprover times out: expired event, expired ledger entry, returns false", async () => {
  const { f, ledger } = files();
  const approver = queueApprover({ timeoutMs: 120, pollMs: 20, file: f, ledgerFile: ledger });
  const ok = await approver({ agent: "build-release", run_id: "run-3", tool: "itch_upload", input: { channel: "html5" } });
  assert.equal(ok, false);
  assert.equal(pending(f).length, 0);
  const [e] = approvalsOf(readLedger(ledger));
  assert.equal(e.decision, "expired");
  assert.equal(e.agent, "build-release");
  assert.equal(get(e.request_id, f)?.state, "expired");
});

test("a torn last line does not swallow the next event", () => {
  const { f, ledger } = files();
  const id = request({ agent: "a", run_id: "r", tool: "t", input: {} }, f);
  appendFileSync(f, '{"event":"appro'); // a writer killed mid-append leaves a fragment
  const rec = decide(id, true, "operator", undefined, f, ledger);
  assert.equal(rec?.state, "approved");
  assert.equal(get(id, f)?.state, "approved");
  assert.equal(pending(f).length, 0);
  assert.equal(approvalsOf(readLedger(ledger)).length, 1);
});

test("a duplicate requested event never resets a decided record", () => {
  const { f, ledger } = files();
  const id = request({ agent: "a", run_id: "r", tool: "t", input: {} }, f);
  decide(id, true, "operator", undefined, f, ledger);
  appendFileSync(f, JSON.stringify({ event: "requested", id, ts: "2026-11-07T00:00:00.000Z", agent: "a", run_id: "r", tool: "t", input: {} }) + "\n");
  assert.equal(get(id, f)?.state, "approved"); // not reset to pending
  assert.equal(pending(f).length, 0);
});

// The reviewer's repro: CLI approve and deny racing on the same ids ledgered both outcomes.
// Invariant regardless of timing: exactly one ledger entry per id, and no id left pending.
test("concurrent CLI decisions on one id ledger exactly one terminal decision", async () => {
  const { f, ledger } = files();
  const ids = Array.from({ length: 6 }, () => request({ agent: "a", run_id: "r", tool: "t", input: {} }, f));
  const cli = (args: string[]) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | undefined }>();
    const cliPath = fileURLToPath(new URL("./approvals.ts", import.meta.url));
    execFile(process.execPath, ["--import", "tsx", cliPath, ...args], { env: { ...process.env, STUDIO_APPROVALS_FILE: f, STUDIO_LEDGER_FILE: ledger } }, (error) => resolve({ code: error?.code === undefined ? 0 : typeof error.code === "number" ? error.code : 1 }));
    return promise;
  };
  // Half the ids get same-kind contenders (approve vs approve): the same-ms collision shape.
  const jobs = ids.flatMap((id, i) => (i % 2 === 0
    ? [cli(["approve", id, "--note", "yes"]), cli(["deny", id, "--note", "no"])]
    : [cli(["approve", id, "--note", "yes"]), cli(["approve", id, "--note", "also yes"])]));
  await Promise.all(jobs);
  const entries = approvalsOf(readLedger(ledger));
  assert.equal(entries.length, ids.length); // one decision per id, never two
  for (const id of ids) {
    assert.equal(entries.filter((e) => e.request_id === id).length, 1);
    assert.notEqual(get(id, f)?.state, "pending");
  }
});

test("terminal events carry unique nonces, so same-millisecond twins are told apart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] }); // freeze the clock: both decisions land in one ms
  const { f, ledger } = files();
  const a = request({ agent: "a", run_id: "r1", tool: "t", input: {} }, f);
  const b = request({ agent: "a", run_id: "r2", tool: "t", input: {} }, f);
  decide(a, true, "operator", undefined, f, ledger);
  decide(b, true, "operator", undefined, f, ledger);
  const terminal = readEventsOf(f).filter((e) => e.event !== "requested");
  assert.equal(terminal.length, 2);
  assert.equal(terminal[0].ts, terminal[1].ts); // same millisecond...
  assert.ok(terminal[0].nonce && terminal[1].nonce && terminal[0].nonce !== terminal[1].nonce); // ...different identity
});

test("a same-ms same-kind collision keeps only the file-order winner's decision", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { f, ledger } = files();
  const id = request({ agent: "a", run_id: "r", tool: "t", input: {} }, f);
  // Another process's approve lands first in file order; ours lands second in the same ms.
  appendFileSync(f, JSON.stringify({ event: "approved", id, ts: new Date().toISOString(), who: "operator-2", nonce: "deadbeefdeadbeef" }) + "\n");
  appendFileSync(f, JSON.stringify({ event: "approved", id, ts: new Date().toISOString(), who: "operator", nonce: "cafebabecafebabe" }) + "\n");
  assert.equal(get(id, f)?.state, "approved");
  assert.equal(get(id, f)?.who, "operator-2"); // the fold keeps the first event, not the last
  assert.equal(approvalsOf(readLedger(ledger)).length, 0); // neither was ledgered by hand; a later decide fast-paths out
  assert.equal(decide(id, true, "operator", undefined, f, ledger), null);
});

test("queueApprover polls until a human decides", async () => {
  const { f, ledger } = files();
  const approver = queueApprover({ timeoutMs: 10_000, pollMs: 20, file: f, ledgerFile: ledger });
  const decided = approver({ agent: "build-release", run_id: "run-4", tool: "itch_upload", input: {} });
  const [req] = pending(f); // the request event is written before the first poll
  assert.equal(req.agent, "build-release");
  decide(req.id, true, "operator", undefined, f, ledger);
  assert.equal(await decided, true);
});

test("first terminal event wins: later decide and expiry are ignored", async () => {
  const { f, ledger } = files();
  const id = request({ agent: "a", run_id: "r", tool: "t", input: {} }, f);
  decide(id, true, "operator", undefined, f, ledger);
  assert.equal(decide(id, false, "operator", "late", f, ledger), null); // already terminal
  assert.equal(get(id, f)?.state, "approved");
  assert.equal(approvalsOf(readLedger(ledger)).length, 1); // no second ledger entry

  // expiry after a decision is a no-op too: this new request expires, the approved one is untouched
  const second = queueApprover({ timeoutMs: 60, pollMs: 20, file: f, ledgerFile: ledger });
  assert.equal(await second({ agent: "a", run_id: "r", tool: "t", input: {} }), false);
  assert.equal(approvalsOf(readLedger(ledger)).length, 2); // only the new request's expired entry
  assert.equal(get(id, f)?.state, "approved");
});

test("a pre-nonce terminal event still wins the fold; nothing ledgers on top of it", () => {
  const { f, ledger } = files();
  const id = request({ agent: "a", run_id: "r", tool: "t", input: {} }, f);
  // A terminal event written by pre-nonce code (an older CLI / a run from before the upgrade).
  appendFileSync(f, JSON.stringify({ event: "denied", id, ts: "2026-11-07T20:00:00.000Z", who: "old-cli" }) + "\n");
  // A later nonce-carrying decision from new code lands second and must not count itself the winner.
  appendFileSync(f, JSON.stringify({ event: "approved", id, ts: "2026-11-07T20:00:00.500Z", who: "operator", nonce: "cafebabecafebabe" }) + "\n");
  const rec = get(id, f);
  assert.equal(rec?.state, "denied");
  assert.equal(rec?.who, "old-cli"); // the fold's winner is the FIRST terminal event, nonce or not
  assert.equal(approvalsOf(readLedger(ledger)).length, 0);
  assert.equal(decide(id, true, "operator", undefined, f, ledger), null); // nothing left to decide, nothing ledgered
});
