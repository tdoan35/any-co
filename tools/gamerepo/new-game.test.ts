import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("guards: only tech-lead pushes main (and it updates the repo's files); agent branches are open", () => {
  const games = mkdtempSync(path.join(tmpdir(), "games-"));
  const { dir } = createGameRepo("Guarded", games);
  const clone = mkdtempSync(path.join(tmpdir(), "clone-"));
  execFileSync("git", ["clone", "-q", dir, clone]);
  const git = (env: Record<string, string>, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
      cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
    });
  writeFileSync(path.join(clone, "a.txt"), "x\n");
  git({}, "add", "a.txt");
  git({}, "commit", "-q", "-m", "a");
  assert.throws(() => git({ ANYCO_AGENT: "gameplay-engineer" }, "push", "-q", "origin", "main"), /single-merger/);
  git({ ANYCO_AGENT: "gameplay-engineer" }, "push", "-q", "origin", "main:agent/gameplay-engineer");
  git({ ANYCO_AGENT: "tech-lead" }, "push", "-q", "origin", "main");
  assert.equal(execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).trim(), "a.txt");
  assert.ok(existsSync(path.join(dir, "a.txt")), "updateInstead checks the pushed main out in the repo");
});
