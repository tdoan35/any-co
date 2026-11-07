import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---- T17: intervention categories ----
import { recategorize, read as readLedger2, INTERVENTION_CATEGORIES } from "./ledger.ts";

const cli = (args: string[], file: string) =>
  execFileSync("node", ["--import", "tsx", "tools/ledger/ledger.ts", ...args], { encoding: "utf8", env: { ...process.env, STUDIO_LEDGER_FILE: file } });

test("T17: CLI intervention defaults to harness; --category is honored; invalid exits 2", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t17-"));
  const f = path.join(dir, "l.jsonl");
  const out = cli(["intervention", "rebuilt the runner loop", "infra"], f);
  assert.match(out, /logged \(harness\)/);
  assert.match(cli(["intervention", "rotated the API keys", "ops", "--category", "account"], f), /logged \(account\)/);
  assert.equal(readLedger2(f).length, 2);
  const entries = readLedger2(f) as Array<{ category?: string }>;
  assert.equal(entries[0].category, "harness");
  assert.equal(entries[1].category, "account");
  // invalid category exits 2 with a readable message
    let failed = false;
  try {
    execFileSync("node", ["--import", "tsx", "tools/ledger/ledger.ts", "intervention", "x", "y", "--category", "vibes"],
      { encoding: "utf8", env: { ...process.env, STUDIO_LEDGER_FILE: f }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = true;
    const err = e as { status: number; stderr: Buffer };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /invalid category "vibes"/);
  }
  assert.ok(failed, "expected exit 2");
  rmSync(dir, { recursive: true, force: true });
});

test("T17: recategorize dry-run proposes, apply rewrites atomically and is idempotent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t17-"));
  const f = path.join(dir, "l.jsonl");
  const lines = [
    JSON.stringify({ kind: "decision", ts: "t1", agent: "a", run_id: "r", topic: "x", decision: "d", rationale: "why" }),
    JSON.stringify({ kind: "intervention", ts: "t2", who: "operator", action: "rotated the butler API key", reason: "ops hygiene" }),
    JSON.stringify({ kind: "intervention", ts: "t3", who: "operator", action: "pressed start on the studio run", reason: "kickoff" }),
    JSON.stringify({ kind: "intervention", ts: "t4", who: "operator", action: "approved the itch push", reason: "gate" }),
    JSON.stringify({ kind: "intervention", ts: "t5", who: "operator", action: "tweaked runner retry", reason: "infra" }),
    JSON.stringify({ kind: "intervention", ts: "t6", who: "operator", action: "already tagged", reason: "prior", category: "steering" }),
    "", // torn trailing newline must survive
  ];
  writeFileSync(f, lines.join("\n"));
  const before = readFileSync(f, "utf8");

  const dry = recategorize({ file: f, log: () => {} });
  assert.deepEqual(dry.matched.map((m) => [m.from, m.to]).sort(), [
    ["uncategorized", "account"], ["uncategorized", "approval"], ["uncategorized", "harness"], ["uncategorized", "steering"],
  ]);
  assert.equal(readFileSync(f, "utf8"), before, "dry-run leaves the file byte-identical");

  const applied = recategorize({ file: f, apply: true, log: () => {} });
  assert.equal(applied.matched.length, 4);
  const after = readLedger2(f);
  const byAction = new Map(after.filter((e) => e.kind === "intervention").map((e) => [e.action, (e as { category?: string }).category]));
  assert.equal(byAction.get("rotated the butler API key"), "account");
  assert.equal(byAction.get("pressed start on the studio run"), "steering");
  assert.equal(byAction.get("approved the itch push"), "approval");
  assert.equal(byAction.get("tweaked runner retry"), "harness");
  assert.equal(byAction.get("already tagged"), "steering"); // pre-tagged line untouched
  // every untouched field survives; the decision line is byte-identical
  const decision = after.find((e) => e.kind === "decision");
  assert.deepEqual(decision, { kind: "decision", ts: "t1", agent: "a", run_id: "r", topic: "x", decision: "d", rationale: "why" });
  // the backfill note is appended, as a harness intervention
  const note = after.at(-1) as { action: string; category?: string };
  assert.match(note.action, /recategorize backfill/);
  assert.equal(note.category, "harness");

  // idempotent: a second apply is a no-op (no new note, no changes)
  const snapshot = readFileSync(f, "utf8");
    const countBefore = readLedger2(f).length;
  const again = recategorize({ file: f, apply: true, log: () => {} });
  assert.equal(again.matched.length, 0);
  assert.equal(readLedger2(f).length, countBefore);
  assert.equal(readFileSync(f, "utf8"), snapshot);
  rmSync(dir, { recursive: true, force: true });
});

test("T17: ledger_recent reports per-category counts; human approvals count as approval", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t17-"));
  const f = path.join(dir, "l.jsonl");
  const approval = (id: string, decision: ApprovalEntry["decision"], who: string): ApprovalEntry =>
    ({ kind: "approval", ts: "t", request_id: id, agent: "a", run_id: "r", tool: "art_signoff", decision, who, input_summary: "{}" });
  append({ kind: "decision", ts: "t", agent: "a", run_id: "r", topic: "t", decision: "d", rationale: "why" }, f);
  append({ kind: "intervention", ts: "t", who: "operator", action: "pressed start", reason: "kickoff", category: "steering" }, f);
  append({ kind: "intervention", ts: "t", who: "operator", action: "old-style line, no category", reason: "r" }, f);
  append(approval("apr-1", "approved", "operator"), f);
  append(approval("apr-2", "approved", "auto (--approve-all)"), f);

  const out = await IMPLS.studio_ledger.ledger_recent.run({ limit: 5 }, { workspace: dir, naive: null, ledgerFile: f });
  const parsed = JSON.parse(out.content);
  assert.deepEqual(parsed.intervention_counts, { steering: 1, uncategorized: 1, approval: 1, "auto/expired": 1 });
  assert.equal(parsed.steering, 1);
  assert.equal(parsed.counts.intervention, 3); // 1 steering + 1 uncategorized + 1 human approval (rule unchanged)
  rmSync(dir, { recursive: true, force: true });
});
