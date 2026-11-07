import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WeaveSnapshotSchema } from "@fabric/contracts";
import { buildWeave } from "./weave.ts";
import { request, decide } from "../../tools/approvals/approvals.ts";

const files = () => {
  const d = mkdtempSync(path.join(tmpdir(), "weave-"));
  return { f: path.join(d, "approvals.jsonl"), ledger: path.join(d, "ledger.jsonl") };
};

test("weave items show pending approvals only, in the contract shape", () => {
  const { f, ledger } = files();
  const id = request({ agent: "build-release", run_id: "run-9", tool: "itch_upload", input: { channel: "html5" } }, f);
  const decided = request({ agent: "build-release", run_id: "run-9", tool: "itch_upload", input: { channel: "win" } }, f);
  decide(decided, true, "operator", undefined, f, ledger);

  const snap = buildWeave([], [], f);
  assert.equal(snap.items.length, 1);
  const item = snap.items[0];
  assert.equal(item.kind, "approval");
  assert.equal(item.id, id);
  assert.equal(item.agentId, "build-release");
  assert.equal(item.tool, "itch_upload");
  assert.deepEqual(item.actions, []); // read-only display: no write endpoint in the window
  WeaveSnapshotSchema.parse(snap);
});
