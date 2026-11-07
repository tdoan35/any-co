import { test } from "node:test";
import assert from "node:assert/strict";
import { NaiveBoard, type BoardClient, type NaiveCard } from "./naive.ts";
import { BoardError } from "./types.ts";

const card = (over: Partial<NaiveCard> = {}): NaiveCard => ({
  id: "crd_1",
  title: "T",
  body: "the brief",
  note: null,
  status: "todo",
  assignee: null,
  blocked_by: [],
  created_at: "2026-11-07T00:00:00Z",
  updated_at: "2026-11-07T00:00:00Z",
  ...over,
});

/** Records every call; answers with the canned card(s). */
function fakeClient(reply: (cmd: string, arg: Record<string, unknown>) => NaiveCard | NaiveCard[]): BoardClient & { calls: Array<{ cmd: string; arg: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; arg: Record<string, unknown> }> = [];
  const one = (cmd: string, arg: Record<string, unknown>): NaiveCard => {
    calls.push({ cmd, arg });
    const r = reply(cmd, arg);
    return Array.isArray(r) ? r[0] : r;
  };
  return {
    calls,
    board: {
      cards: {
        list: async (ref, q) => {
          calls.push({ cmd: "list", arg: { ref, ...q } });
          const r = reply("list", { ref, ...q });
          return { data: Array.isArray(r) ? r : [r], has_more: false, next_cursor: null };
        },
        create: async (ref, body) => one("create", { ref, ...body }),
        get: async (ref, id) => one("get", { ref, id }),
        update: async (ref, id, body) => one("update", { ref, id, ...body }),
        comments: async () => ({ data: [], has_more: false, next_cursor: null }),
        comment: async (ref, id, body) => ({ id: "cmt_1", card_id: id, author: "ses_1", body: body.body, created_at: "2026-11-07T00:00:00Z" }),
      },
    },
  };
}

test("create never sends a local assignee; it rides in the body header", async () => {
  const c = fakeClient((cmd, arg) => card(cmd === "create" ? { body: String(arg.body) } : {}));
  const b = new NaiveBoard(c, "agt_head");
  const { card: made } = await b.create({ title: "Do the thing", body: "brief text", assignee: "market-analyst" });
  const create = c.calls.find((x) => x.cmd === "create")!;
  assert.equal(create.arg.assignee, null); // assignment on Naïve would wake a hosted session
  assert.equal(create.arg.body, "local-assignee: market-analyst\n\nbrief text");
  assert.equal(made.assignee, "market-analyst"); // decoded back out of the header
  assert.equal(made.body, "brief text");
});

test("a card without the header round-trips unchanged", async () => {
  const c = fakeClient(() => card({ assignee: null, body: "plain brief" }));
  const b = new NaiveBoard(c, "brd_1");
  assert.equal((await b.get("crd_1")).body, "plain brief");
  assert.equal((await b.get("crd_1")).assignee, null);
});

test("update sends status and note but never assignee (a reassignment resets the wake)", async () => {
  const c = fakeClient(() => card());
  const b = new NaiveBoard(c, "brd_1");
  await b.update("crd_1", { status: "done", note: "finished" });
  const update = c.calls.find((x) => x.cmd === "update")!;
  assert.equal(update.arg.status, "done");
  assert.equal(update.arg.note, "finished");
  assert.equal("assignee" in update.arg, false);
});

test("list follows pagination cursors", async () => {
  let page = 0;
  const c = fakeClient((cmd) => {
    if (cmd !== "list") return card();
    page++;
    return [card({ id: `crd_p${page}` })];
  });
  // make the first page report more
  const paged: BoardClient = {
    board: {
      cards: {
        ...c.board.cards,
        list: async (ref, q) => {
          const r = await c.board.cards.list(ref, q);
          return page === 1 ? { ...r, has_more: true, next_cursor: "cur" } : r;
        },
      },
    },
  };
  const b = new NaiveBoard(paged, "brd_1");
  const cards = await b.list();
  assert.deepEqual(cards.map((x) => x.id), ["crd_p1", "crd_p2"]);
});

test("server refusals surface as BoardError with the server's code", async () => {
  const boom: BoardClient = {
    board: {
      cards: {
        ...fakeClient(() => card()).board.cards,
        update: async () => {
          throw Object.assign(new Error("a done needs a note"), { code: "missing_note" });
        },
      },
    },
  };
  const b = new NaiveBoard(boom, "brd_1");
  await assert.rejects(b.update("crd_1", { status: "done" }), (e: unknown) => e instanceof BoardError && e.code === "missing_note");
});
