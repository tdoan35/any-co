import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGameRepo, pickedTitle, slugify } from "./new-game.ts";

test("slugify: lowercase ascii words joined by dashes", () => {
  assert.equal(slugify("Alpha Beta"), "alpha-beta");
  assert.equal(slugify("  Ünïcode & Things!! "), "unicode-and-things");
  assert.equal(slugify("a".repeat(80)).length, 60);
  assert.throws(() => slugify("!!!"));
});

test("pickedTitle reads pick.working_title from a chair run", () => {
  const run = mkdtempSync(path.join(tmpdir(), "chair-"));
  writeFileSync(path.join(run, "output.json"), JSON.stringify({ pick: { working_title: "Placeholder Title" } }));
  assert.equal(pickedTitle(run), "Placeholder Title");
  writeFileSync(path.join(run, "output.json"), JSON.stringify({ pick: {} }));
  assert.throws(() => pickedTitle(run));
});

test("createGameRepo makes a git repo with one empty commit and refuses to overwrite", () => {
  const games = mkdtempSync(path.join(tmpdir(), "games-"));
  mkdirSync(games, { recursive: true });
  const r = createGameRepo("Placeholder Title", games);
  assert.equal(r.slug, "placeholder-title");
  const log = execFileSync("git", ["log", "--oneline"], { cwd: r.dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(log.length, 1);
  assert.equal(execFileSync("git", ["ls-files"], { cwd: r.dir, encoding: "utf8" }).trim(), "");
  assert.throws(() => createGameRepo("Placeholder Title", games), /already exists/);
});
