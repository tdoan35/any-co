import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS } from "../../runner/tools/impl.ts";
import { append, read, type ApprovalEntry } from "./ledger.ts";

test("append and read survive a torn last line", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "ledger-")), "l.jsonl");
  append({ kind: "decision", ts: "t", agent: "a", run_id: "r", topic: "x", decision: "d", rationale: "why" }, f);
  append({ kind: "intervention", ts: "t", who: "operator", action: "pressed start", reason: "kickoff" }, f);
  writeFileSync(f, readFileSync(f, "utf8") + "{\"kind\":\"decis", "utf8");
  const e = read(f);
  assert.equal(e.length, 2);
  assert.equal(e[1].kind, "intervention");
});

test("ledger_recent returns counts and newest-first entries", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const f = path.join(dir, "l.jsonl");
  append({ kind: "decision", ts: "2026-11-07T01:00:00Z", agent: "a", run_id: "r1", topic: "t1", decision: "d", rationale: "why" }, f);
  append({ kind: "intervention", ts: "2026-11-07T02:00:00Z", who: "operator", action: "approved spend", reason: "needed" }, f);
  append({ kind: "decision", ts: "2026-11-07T03:00:00Z", agent: "b", run_id: "r2", topic: "t2", decision: "d2", rationale: "why2" }, f);

  const out = await IMPLS.studio_ledger.ledger_recent.run({ limit: 2 }, { workspace: dir, naive: null, ledgerFile: f });
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.counts, { decision: 2, intervention: 1 });
  assert.equal(parsed.recent.length, 2);
  assert.equal(parsed.recent[0].topic, "t2"); // newest first
  assert.equal(parsed.recent[1].kind, "intervention");

  const empty = await IMPLS.studio_ledger.ledger_recent.run({ limit: 5 }, { workspace: dir, naive: null, ledgerFile: path.join(dir, "none.jsonl") });
  assert.equal(JSON.parse(empty.content).total, 0);
});

test("ledger_recent counts human approval decisions as interventions; auto and expired are not", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  const f = path.join(dir, "l.jsonl");
  const approval = (request_id: string, decision: ApprovalEntry["decision"], who: string): ApprovalEntry =>
    ({ kind: "approval", ts: "2026-11-07T04:00:00Z", request_id, agent: "build-release", run_id: "r3", tool: "itch_upload", decision, who, input_summary: "{}" });
  append(approval("apr-1", "approved", "operator"), f);
  append(approval("apr-2", "denied", "operator"), f);
  append(approval("apr-3", "approved", "auto (--approve-all)"), f);
  append(approval("apr-4", "expired", "timeout"), f);
  append({ kind: "decision", ts: "2026-11-07T05:00:00Z", agent: "a", run_id: "r4", topic: "t3", decision: "d3", rationale: "why3" }, f);

  const out = await IMPLS.studio_ledger.ledger_recent.run({ limit: 10 }, { workspace: dir, naive: null, ledgerFile: f });
  const parsed = JSON.parse(out.content);
  assert.equal(parsed.counts.approval, 4);
  assert.equal(parsed.counts.intervention, 2); // the two human decisions, not auto or expired
  assert.ok(parsed.recent.some((e: { kind: string; request_id?: string }) => e.kind === "approval" && e.request_id === "apr-1"));
});
