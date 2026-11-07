import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request, decide, pending, get, queueApprover } from "./approvals.ts";
import { read as readLedger, type ApprovalEntry, type LedgerEntry } from "../ledger/ledger.ts";

const files = () => {
  const d = mkdtempSync(path.join(tmpdir(), "approvals-"));
  return { f: path.join(d, "approvals.jsonl"), ledger: path.join(d, "ledger.jsonl") };
};
const approvalsOf = (entries: LedgerEntry[]): ApprovalEntry[] => entries.filter((e): e is ApprovalEntry => e.kind === "approval");

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
