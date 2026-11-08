// node --import tsx --test window/src/lib/api/board-view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { Run, Task } from "@fabric/contracts";
import { buildBoardView, cardTitleOf, gameName, type BoardCardRow } from "./board-view";

const run = (id: string, objective: string, startedAt: string, game: string | null, teamId = "team-eng"): Run => ({
  id, taskId: `task-${id}`, teamId, n: 1, objective, status: "accepted", startedAt, recorded: false, durationS: 60,
  costUsd: 0.1, budget: { costUsd: 1, timeS: 900 }, reworkBudget: 0, assistantTokens: 0,
  brief: { tokens: 0, objective, constraints: [], criteria: [], preferences: [], stayed: [] }, segments: [], game,
} as Run);
const taskOfRun = (r: Run): Task => ({ id: r.taskId, projectId: "studio", teamId: r.teamId, title: r.objective, runIds: [r.id] });
const card = (id: string, title: string, status: BoardCardRow["status"], game: string | null, created_at: string, assignee = "tech-lead"): BoardCardRow =>
  ({ id, title, status, assignee, game, created_at, updated_at: created_at });

test("gameName and cardTitleOf", () => {
  assert.equal(gameName("caravan-cargo-cult"), "Caravan Cargo Cult");
  assert.equal(gameName("soul-shift"), "Soul Shift");
  assert.equal(cardTitleOf("# Build the map\n\nmore"), "Build the map");
  assert.equal(cardTitleOf("Studio cycle. It is now Sun"), undefined);
});

test("cards become tasks holding their runs; card-less runs stay, filed by game; projects per game plus Studio", () => {
  const r1 = run("r1", "# Build the map\nbrief", "2026-11-08T01:00:00Z", "caravan-cargo-cult");
  const r2 = run("r2", "# Build the map\nretry", "2026-11-08T02:00:00Z", "caravan-cargo-cult");
  const r3 = run("r3", "Studio cycle. It is now Sun 2:00", "2026-11-08T03:00:00Z", null, "team-head");
  const r4 = run("r4", "# Title screen", "2026-11-08T04:00:00Z", "soul-shift");
  const cards = [
    card("c1", "Build the map", "done", "caravan-cargo-cult", "2026-11-08T00:30:00Z"),
    card("c2", "Title screen", "doing", null, "2026-11-08T03:30:00Z"),
    card("c3", "Export check", "todo", "soul-shift", "2026-11-08T05:00:00Z", "qa-lead"),
  ];
  const v = buildBoardView({ tasks: [r1, r2, r3, r4].map(taskOfRun), runs: [r1, r2, r3, r4], cards, teamOfAgent: (a) => (a === "qa-lead" ? "team-qa" : undefined) });

  const c1 = v.tasks.find((t) => t.id === "c1")!;
  assert.deepEqual(c1.runIds, ["r1", "r2"]);
  assert.equal(c1.projectId, "caravan-cargo-cult");
  assert.equal(v.tasks.find((t) => t.id === "c2")!.projectId, "studio", "a card the adapter left without a game is studio-level, whatever its runs cloned");
  const c3 = v.tasks.find((t) => t.id === "c3")!;
  assert.deepEqual(c3.runIds, []);
  assert.equal(c3.teamId, "team-qa", "a todo card is filed under its assignee's team");
  assert.equal(v.tasks.find((t) => t.id === "task-r3")!.projectId, "studio");
  assert.equal(v.tasks.some((t) => t.id === "task-r1"), false, "a run's own task folds into its card");
  assert.equal(v.taskOf.get("task-r2"), "c1");
  assert.equal(v.taskOf.get("task-r3"), "task-r3");
  assert.deepEqual(v.projects.map((p) => p.name), ["Soul Shift", "Caravan Cargo Cult", "Studio"], "games by latest activity, Studio last");
});

test("same-title cards: a run joins the latest one made before it started, same game first", () => {
  const cards = [
    card("old", "Re-gate", "done", "soul-shift", "2026-11-08T01:00:00Z"),
    card("new", "Re-gate", "done", "soul-shift", "2026-11-08T05:00:00Z"),
    card("other", "Re-gate", "done", "caravan-cargo-cult", "2026-11-08T04:00:00Z"),
  ];
  const early = run("e", "# Re-gate", "2026-11-08T02:00:00Z", "soul-shift");
  const late = run("l", "# Re-gate", "2026-11-08T06:00:00Z", "soul-shift");
  const v = buildBoardView({ tasks: [early, late].map(taskOfRun), runs: [early, late], cards, teamOfAgent: () => undefined });
  assert.equal(v.taskOf.get("task-e"), "old");
  assert.equal(v.taskOf.get("task-l"), "new");
});
