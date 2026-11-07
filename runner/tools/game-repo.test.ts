import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS } from "../../runner/tools/impl.ts";
import type { ToolContext } from "../../runner/tools/impl.ts";

// A real game repo: git init + one commit, like the Tech Lead's hour-one skeleton.
function makeGamesRoot(): { root: string; repo: string } {
  const root = mkdtempSync(path.join(tmpdir(), "anyco-games-"));
  const repo = path.join(root, "testgame");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "--quiet", "--initial-branch", "main");
  writeFileSync(path.join(repo, "README.md"), "# testgame\n");
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "init"]);
  return { root, repo: "testgame" };
}

const ctxFor = (root: string): ToolContext => ({ workspace: mkdtempSync(path.join(tmpdir(), "anyco-run-")), naive: null, gameRepoRoot: root, agent: "gameplay-engineer" });

test("game_repo: clone, write, read, exec, branch, and commit", async () => {
  const { root } = makeGamesRoot();
  const ctx = ctxFor(root);

  const clone = await IMPLS.game_repo.game_clone.run({}, ctx);
  const info = JSON.parse(clone.content);
  assert.equal(clone.is_error, undefined);
  assert.equal(info.game, "testgame");
  assert.equal(info.branch, "agent/gameplay-engineer");
  assert.ok(existsSync(path.join(ctx.workspace, "game", "README.md")));

  // idempotent: a second clone returns the same branch without touching anything
  const again = JSON.parse((await IMPLS.game_repo.game_clone.run({}, ctx)).content);
  assert.equal(again.branch, info.branch);

  await IMPLS.game_repo.game_write.run({ path: "src/hello.txt", content: "hi" }, ctx);
  const read = await IMPLS.game_repo.game_read.run({ path: "src/hello.txt" }, ctx);
  assert.equal(read.content, "hi");

  const status = await IMPLS.game_repo.game_exec.run({ command: ["git", "status", "--porcelain", "-uall"] }, ctx);
  assert.match(status.content, /src\/hello\.txt/);

  await IMPLS.game_repo.game_exec.run({ command: ["git", "add", "-A"] }, ctx);

  // commit on the agent branch, never on main
  await IMPLS.game_repo.game_exec.run(
    { command: ["git", "-c", "user.email=a@a", "-c", "user.name=a", "commit", "--quiet", "-m", "wip"] },
    ctx,
  );
  const committed = await IMPLS.game_repo.game_exec.run({ command: ["git", "show", "--stat", "--oneline", "HEAD"] }, ctx);
  assert.match(committed.content, /src\/hello\.txt/);
  const branch = await IMPLS.game_repo.game_exec.run({ command: ["git", "rev-parse", "--abbrev-ref", "HEAD"] }, ctx);
  assert.match(branch.content, /agent\/gameplay-engineer/);

  // non-zero exit is an error result
  const fail = await IMPLS.game_repo.game_exec.run({ command: ["git", "checkout", "no-such-branch"] }, ctx);
  assert.equal(fail.is_error, true);

  // paths cannot escape the clone
  const escape = await IMPLS.game_repo.game_write.run({ path: "../outside.txt", content: "x" }, ctx);
  assert.equal(escape.is_error, true);
});

test("game_repo: no repo, ambiguous repos, and exec before clone are clear errors", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "anyco-games-"));
  const none = await IMPLS.game_repo.game_clone.run({}, ctxFor(empty));
  assert.equal(none.is_error, true);
  assert.match(none.content, /no game repo/);

  const { root } = makeGamesRoot();
  mkdirSync(path.join(root, "secondgame"));
  execFileSync("git", ["-C", path.join(root, "secondgame"), "init", "--quiet"]);
  writeFileSync(path.join(root, "secondgame", "f"), "x");
  execFileSync("git", ["-C", path.join(root, "secondgame"), "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  execFileSync("git", ["-C", path.join(root, "secondgame"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "i"]);
  const both = await IMPLS.game_repo.game_clone.run({}, ctxFor(root));
  assert.equal(both.is_error, true);
  assert.match(both.content, /several game repos/);

  const noClone = await IMPLS.game_repo.game_exec.run({ command: ["git", "status"] }, ctxFor(root));
  assert.equal(noClone.is_error, true);
  assert.match(noClone.content, /game_clone first/);
});
