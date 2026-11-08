import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("weave shows board cards read-only: doing → presence, blocked → pulse + presence; todo/done stay out", () => {
  const { f } = files();
  const at = "2026-11-07T22:00:00.000Z";
  const card = (id: string, status: "todo" | "doing" | "blocked" | "done", assignee: string, note: string | null = null) =>
    ({ id, title: `Card ${id}`, body: "", note, status, assignee, blocked_by: [], created_at: at, updated_at: at });
  const snap = buildWeave([], ["market-analyst", "tech-lead", "qa-lead", "playtester"], f, undefined, [
    card("c1", "doing", "market-analyst"),
    card("c2", "blocked", "tech-lead", "error: run r-1 — build failed"),
    card("c3", "todo", "qa-lead"),
    card("c4", "done", "playtester", "done: run r-2"),
  ]);
  const p = Object.fromEntries(snap.presence.map((x) => [x.agentId, x]));
  assert.equal(p["market-analyst"].state, "working");
  assert.match(p["market-analyst"].activity, /Board · Card c1/);
  assert.equal(p["tech-lead"].state, "blocked");
  assert.equal(p["qa-lead"].state, "idle");
  assert.equal(p["playtester"].state, "idle");
  assert.deepEqual(snap.pulse.map((e) => e.id), ["board:c2"]);
  assert.match((snap.pulse[0] as { text: string }).text, /Blocked: Card c2 — error: run r-1/);
  assert.deepEqual(snap.items, []); // board cards are not inbox items: no write path
  WeaveSnapshotSchema.parse(snap);
});

test("weave calendar: events from runs/calendar.json, filtered to the contract shape; absent or malformed file is empty", () => {
  const d = mkdtempSync(path.join(tmpdir(), "weave-cal-"));
  const f = path.join(d, "approvals.jsonl");
  // Absent file: no calendar, no throw.
  assert.deepEqual(buildWeave([], [], f, d).calendar, []);
  // Valid entries pass through; junk entries and unknown kinds are dropped.
  writeFileSync(path.join(d, "calendar.json"), JSON.stringify({ events: [
    { id: "breakfast", title: "Breakfast served", start: "2026-11-08T09:00:00-08:00", end: "2026-11-08T09:45:00-08:00", kind: "personal" },
    { id: "junk" },
    { id: "odd-kind", title: "x", start: "2026-11-08T10:00:00-08:00", end: "2026-11-08T10:30:00-08:00", kind: "party" },
  ] }));
  const snap = buildWeave([], [], f, d);
  assert.deepEqual(snap.calendar.map((e) => e.id), ["breakfast"]);
  WeaveSnapshotSchema.parse(snap);
  // Malformed JSON: still no throw, no calendar.
  writeFileSync(path.join(d, "calendar.json"), "{not json");
  assert.deepEqual(buildWeave([], [], f, d).calendar, []);
});
