import test from "node:test";
import assert from "node:assert/strict";
import { summarizeBoard } from "./board-summary.ts";
import type { BoardCard } from "../../runner/board/types.ts";

const card = (assignee: string | null, status: BoardCard["status"]): BoardCard => ({
  id: `c-${Math.random()}`, title: "t", body: "b", note: null, status, assignee, blocked_by: [], created_at: "", updated_at: "",
});

test("board summary: counts per assignee and status, unassigned under empty key", () => {
  const s = summarizeBoard([card("qa-lead", "done"), card("qa-lead", "doing"), card("qa-lead", "done"), card(null, "todo"), card("tech-lead", "blocked")]);
  assert.deepEqual(s.byAssignee["qa-lead"], { todo: 0, doing: 1, blocked: 0, done: 2 });
  assert.deepEqual(s.byAssignee[""], { todo: 1, doing: 0, blocked: 0, done: 0 });
  assert.deepEqual(s.byAssignee["tech-lead"], { todo: 0, doing: 0, blocked: 1, done: 0 });
});

test("board summary: an empty board is an empty map", () => {
  assert.deepEqual(summarizeBoard([]), { byAssignee: {}, runsByAgent: {} });
});

test("board summary: finished runs per agent, running ones left out", () => {
  const s = summarizeBoard([], [{ agent: "greenlight-chair", running: false }, { agent: "greenlight-chair", running: false }, { agent: "qa-lead", running: true }]);
  assert.deepEqual(s.runsByAgent, { "greenlight-chair": 2 });
});
