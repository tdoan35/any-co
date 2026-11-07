import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBoard } from "./local.ts";
import { BoardError } from "./types.ts";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "anyco-board-")), "board.jsonl");
const rejects = async (p: Promise<unknown>, code: BoardError["code"]) => {
  await assert.rejects(p, (e: unknown) => e instanceof BoardError && e.code === code);
};

test("create defaults: todo, unassigned; create with blocked_by starts blocked", async () => {
  const b = new LocalBoard(tmpFile());
  const a = await b.create({ title: "Write the brief" });
  assert.equal(a.card.status, "todo");
  assert.equal(a.card.assignee, null);
  assert.equal(a.card.body, "");
  const { card: blocked } = await b.create({ title: "Review it", assignee: "alpha-agent", blocked_by: [a.card.id] });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blocked_by, [a.card.id]);
  assert.equal(blocked.assignee, "alpha-agent");
});

test("done requires a note, and done is terminal", async () => {
  const b = new LocalBoard(tmpFile());
  const { card } = await b.create({ title: "A", assignee: "alpha-agent" });
  await rejects(b.update(card.id, { status: "done" }), "missing_note");
  await b.update(card.id, { status: "doing" });
  await rejects(b.update(card.id, { status: "done" }), "missing_note"); // no note on card or call
  const done = await b.update(card.id, { status: "done", note: "wrote it" });
  assert.equal(done.note, "wrote it");
  await rejects(b.update(card.id, { status: "todo" }), "already_resolved");
});

test("key idempotency: the same key answers the card it made, not a duplicate", async () => {
  const b = new LocalBoard(tmpFile());
  const first = await b.create({ title: "Seed the board", key: "seed-1" });
  const again = await b.create({ title: "Seed the board (retry)", key: "seed-1" });

  assert.equal(again.card.id, first.card.id);
  assert.equal(again.card.title, "Seed the board");
  assert.equal((await b.list()).length, 1);
});

test("blocked_by must name cards that exist", async () => {
  const b = new LocalBoard(tmpFile());
  await rejects(b.create({ title: "A", blocked_by: ["crd_nope"] }), "unknown_blocker");
});

test("healing: a blocked card whose blockers are all done reads as todo; an empty blocked_by stays blocked", async () => {
  const b = new LocalBoard(tmpFile());
  const a = await b.create({ title: "A" });
  const { card: stuck } = await b.create({ title: "Stuck on the world", status: "blocked" });
  const { card: waiting } = await b.create({ title: "B waits on A", blocked_by: [a.card.id] });
  await b.update(a.card.id, { status: "done", note: "A finished" });
  assert.equal((await b.get(waiting.id)).status, "todo"); // healed on read
  assert.equal((await b.get(stuck.id)).status, "blocked"); // empty list = stuck on the world
});

test("one doing card per assignee", async () => {
  const b = new LocalBoard(tmpFile());
  const one = await b.create({ title: "First", assignee: "alpha-agent" });
  const two = await b.create({ title: "Second", assignee: "alpha-agent" });
  await b.update(one.card.id, { status: "doing" });
  await rejects(b.update(two.card.id, { status: "doing" }), "already_working");
  await b.update(one.card.id, { status: "done", note: "ok" });
  const claim = await b.update(two.card.id, { status: "doing" });
  assert.equal(claim.status, "doing");
});

test("state is the fold: a fresh instance over the same file sees every card and comment", async () => {
  const file = tmpFile();
  const b = new LocalBoard(file);
  const { card } = await b.create({ title: "Persistent" });
  await b.update(card.id, { status: "doing" });
  await b.update(card.id, { note: "claimed" });
  await b.comment(card.id, "halfway there", "dispatcher");
  const raw = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(raw.length, 4); // created + claim + note + comment — append-only
  const b2 = new LocalBoard(file);
  const read = await b2.get(card.id);
  assert.equal(read.status, "doing");
  assert.equal(read.note, "claimed");
  assert.equal((await b2.comments(card.id))[0].body, "halfway there");
});

test("unknown card ids refuse with unknown_card", async () => {
  const b = new LocalBoard(tmpFile());
  await rejects(b.get("crd_missing"), "unknown_card");
  await rejects(b.update("crd_missing", { status: "todo" }), "unknown_card");
  await rejects(b.comment("crd_missing", "hi", "x"), "unknown_card");
});

test("R2: claiming a doing card again is refused — first claim in file order wins", async () => {
  const file = tmpFile();
  const one = await new LocalBoard(file).create({ title: "Contested", assignee: "alpha-agent" });
  const b1 = new LocalBoard(file);
  const b2 = new LocalBoard(file); // a second dispatcher over the same board
  const won = await b1.update(one.card.id, { status: "doing", claim: { pid: 111, host: "h1" } });
  assert.equal(won.status, "doing");
  assert.equal(won.claim?.pid, 111);
  await rejects(b2.update(one.card.id, { status: "doing", claim: { pid: 222, host: "h2" } }), "already_claimed");
  await rejects(b1.update(one.card.id, { status: "doing", claim: { pid: 333, host: "h3" } }), "already_claimed"); // not todo anymore
  // the winner is recorded on the card, and cleared when the card moves on
  const seen = await new LocalBoard(file).get(one.card.id);
  assert.equal(seen.claim?.pid, 111);
  await b1.update(one.card.id, { status: "done", note: "done by the winner" });
  assert.equal((await new LocalBoard(file).get(one.card.id)).claim, null);
});

test("R5: a claim is not a note — done still needs one", async () => {
  const b = new LocalBoard(tmpFile());
  const { card } = await b.create({ title: "Claimed", assignee: "alpha-agent" });
  await b.update(card.id, { status: "doing", claim: { pid: 1, host: "h" } });
  await b.comment(card.id, "dispatcher: claimed for local run", "dispatcher"); // the claim rides as a comment, never the note
  assert.equal((await b.get(card.id)).note, null);
  await rejects(b.update(card.id, { status: "done" }), "missing_note");
});
