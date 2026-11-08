// T38: board_create supersedes (tool), refusals before any create, and the Naïve re-point PATCH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBoard } from "./local.ts";
import { NaiveBoard, type BoardClient, type NaiveCard } from "./naive.ts";
import { supersedesOf } from "./supersede.ts";
import { IMPLS, type ToolContext } from "../tools/impl.ts";

function ctxWith(board: LocalBoard): ToolContext {
  const ws = mkdtempSync(path.join(tmpdir(), "t38-"));
  return { workspace: ws, naive: null, runsDir: ws, run_id: "head-1", agent: "studio-head", board } as ToolContext;
}
const create = (ctx: ToolContext, input: Record<string, unknown>) => IMPLS.board.board_create.run({ title: "Replacement card", assignee: "qa-lead", ...input }, ctx);

test("T38 board_create supersedes: marker in the body, dependents re-pointed (open ones only), old card closed", async () => {
  const board = new LocalBoard(path.join(mkdtempSync(path.join(tmpdir(), "t38b-")), "board.jsonl"));
  const ctx = ctxWith(board);
  const old = (await board.create({ title: "Old", assignee: "qa-lead" })).card;
  await board.update(old.id, { status: "blocked", note: "max turns" });
  const other = (await board.create({ title: "Other", assignee: "tech-lead" })).card;
  const b = (await board.create({ title: "B", assignee: "tech-lead", blocked_by: [old.id] })).card;
  const c = (await board.create({ title: "C", assignee: "playtester", blocked_by: [old.id, other.id] })).card;
  const r = await create(ctx, { supersedes: old.id, body: "Smaller scope." });
  assert.equal(r.is_error, undefined, r.content);
  const out = JSON.parse(r.content);
  assert.equal(supersedesOf(out), old.id);
  assert.match(out.body, /\n\nSmaller scope\.$/);
  assert.deepEqual({ ...out.superseded, repointed: [...out.superseded.repointed].sort() }, { old: old.id, by: out.id, repointed: [b.id, c.id].sort(), closed: true }); // same-ms cards sort by random id
  assert.deepEqual((await board.get(b.id)).blocked_by, [out.id]);
  assert.deepEqual((await board.get(c.id)).blocked_by, [out.id, other.id]);
  assert.deepEqual((await board.get(out.id)).blocked_by, [], "the replacement does not wait on itself or the old card");
  const closed = await board.get(old.id);
  assert.deepEqual([closed.status, closed.note], ["done", `superseded by ${out.id}`]);
});

test("T38 board_create supersedes is refused before any card is made: unknown, doing, done, or waiting on the old card", async () => {
  const board = new LocalBoard(path.join(mkdtempSync(path.join(tmpdir(), "t38c-")), "board.jsonl"));
  const ctx = ctxWith(board);
  const doing = (await board.create({ title: "Doing", assignee: "qa-lead" })).card;
  await board.update(doing.id, { status: "doing", claim: { pid: process.pid, host: "h" } });
  const done = (await board.create({ title: "Done", assignee: "tech-lead" })).card;
  await board.update(done.id, { status: "done", note: "shipped" });
  const blocked = (await board.create({ title: "Blocked", assignee: "playtester" })).card;
  await board.update(blocked.id, { status: "blocked", note: "x" });
  const before = (await board.list()).length;
  for (const [input, re] of [
    [{ supersedes: "crd_nope" }, /unknown card: crd_nope/],
    [{ supersedes: doing.id }, /is doing/],
    [{ supersedes: done.id }, /already done/],
    [{ supersedes: blocked.id, blocked_by: [blocked.id] }, /cannot wait on the card it supersedes/],
  ] as const) {
    const r = await create(ctx, input);
    assert.equal(r.is_error, true);
    assert.match(r.content, re);
  }
  assert.equal((await board.list()).length, before, "no card was created");
});

test("T38 Naïve backend: a repoint PATCHes the card's whole blocked_by list with the edge swapped", async () => {
  const card = (id: string, blocked_by: string[]): NaiveCard => ({ id, title: id, body: "", note: null, status: "blocked", assignee: null, blocked_by, created_at: "t", updated_at: "t" });
  const patches: Array<{ id: string; body: unknown }> = [];
  const client: BoardClient = {
    board: {
      cards: {
        list: async () => ({ data: [], has_more: false, next_cursor: null }),
        create: async () => card("crd_x", []),
        get: async (_ref, id) => card(id, ["crd_old", "crd_keep"]),
        update: async (_ref, id, body) => {
          patches.push({ id, body });
          return card(id, (body.blocked_by as string[]) ?? []);
        },
        comments: async () => ({ data: [], has_more: false, next_cursor: null }),
        comment: async (_ref, id, body) => ({ id: "c", card_id: id, author: "key_1", body: body.body, created_at: "t" }),
      },
    },
  };
  const out = await new NaiveBoard(client, "brd_1").update("crd_dep", { repoint: { from: "crd_old", to: "crd_new" } });
  assert.deepEqual(out.blocked_by, ["crd_new", "crd_keep"]);
  assert.deepEqual(patches, [{ id: "crd_dep", body: { status: undefined, note: undefined, body: undefined, title: undefined, blocked_by: ["crd_new", "crd_keep"] } }]);
  await new NaiveBoard(client, "brd_1").update("crd_dep", { status: "todo" });
  assert.equal("blocked_by" in (patches[1].body as object), false, "a plain move never writes blocked_by");
});
