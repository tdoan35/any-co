import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGameRepo } from "../tools/gamerepo/new-game.ts";
import { checkpointGameClone } from "./checkpoint.ts";

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" }).trim();

function setup(branch: string) {
  const games = mkdtempSync(path.join(tmpdir(), "cp-games-"));
  const { dir } = createGameRepo("Checkpoint Probe", games);
  const ws = mkdtempSync(path.join(tmpdir(), "cp-ws-"));
  execFileSync("git", ["clone", "-q", dir, path.join(ws, "game")]);
  if (branch !== "main") g(path.join(ws, "game"), "checkout", "-q", "-b", branch);
  return { repo: dir, ws, clone: path.join(ws, "game") };
}

test("checkpoint: dirty agent branch is committed and pushed to that branch", async () => {
  const { repo, ws, clone } = setup("agent/probe");
  writeFileSync(path.join(clone, "work.gd"), "extends Node\n");
  const r = await checkpointGameClone(ws, "probe", "run1", "max_turns");
  assert.ok(r && r.checkpointed && r.pushed, JSON.stringify(r));
  assert.equal(r!.branch, "agent/probe");
  assert.match(g(repo, "log", "--oneline", "-1", "agent/probe"), /auto-checkpoint: run run1 ended max_turns/);
  assert.equal(g(repo, "log", "--oneline", "main").split("\n").length, 1, "main untouched");
});

test("checkpoint: dirty main goes to a wip branch, never to main", async () => {
  const { repo, ws, clone } = setup("main");
  writeFileSync(path.join(clone, "x.txt"), "x\n");
  const r = await checkpointGameClone(ws, "tech-lead", "run2", "budget_exceeded");
  assert.ok(r && r.checkpointed && r.pushed, JSON.stringify(r));
  assert.equal(r!.branch, "wip/tech-lead-run2");
  assert.equal(g(repo, "log", "--oneline", "main").split("\n").length, 1, "main untouched even for the tech-lead");
  assert.match(g(repo, "log", "--oneline", "-1", "wip/tech-lead-run2"), /auto-checkpoint/);
});

test("checkpoint: no clone is a no-op; a clean branch with unpushed commits is pushed", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "cp-none-"));
  assert.equal(await checkpointGameClone(empty, "a", "r", "done"), null);
  const { repo, ws, clone } = setup("agent/clean");
  mkdirSync(path.join(clone, "src"));
  writeFileSync(path.join(clone, "src", "a.gd"), "extends Node\n");
  g(clone, "add", "-A");
  g(clone, "commit", "-q", "-m", "agent commit");
  const r = await checkpointGameClone(ws, "clean", "r3", "done");
  assert.ok(r && !r.checkpointed && r.pushed, JSON.stringify(r));
  assert.match(g(repo, "log", "--oneline", "-1", "agent/clean"), /agent commit/);
});
