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

test("game_clone copies the harness contracts into the workspace (read-only reference) and ANYCO_AGENT reaches game_exec", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { CONTRACTS_DIR } = await import("../../runner/tools/impl.ts");
  const { root } = makeGamesRoot();
  const ctx = ctxFor(root);
  const info = JSON.parse((await IMPLS.game_repo.game_clone.run({}, ctx)).content);
  assert.match(info.contracts, /contracts\//);
  for (const f of readdirSync(CONTRACTS_DIR).filter((f) => /\.(md|json)$/.test(f))) {
    assert.equal(readFileSync(path.join(ctx.workspace, "contracts", f), "utf8"), readFileSync(path.join(CONTRACTS_DIR, f), "utf8"), f);
  }
  assert.ok(!existsSync(path.join(ctx.workspace, "game", "contracts")), "the copy stays outside the clone");
  const r = await IMPLS.game_repo.game_exec.run({ command: ["sh", "-c", "printf %s \"$ANYCO_AGENT\""] }, ctx);
  assert.match(r.content, /gameplay-engineer/);
});

test("game_clone: repo names that leave games/ are refused and nothing is cloned (harness repo unreachable)", async () => {
  const { symlinkSync } = await import("node:fs");
  const gitEnv = { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } };
  const commitAll = (dir: string) => {
    execFileSync("git", ["-C", dir, "init", "--quiet"], gitEnv);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], gitEnv);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "i"], gitEnv);
  };
  // Production shape: games/ lives inside the harness repo, so "games/.." IS the harness.
  const harness = mkdtempSync(path.join(tmpdir(), "anyco-harness-"));
  writeFileSync(path.join(harness, "harness-secret.txt"), "harness");
  mkdirSync(path.join(harness, "private"));
  writeFileSync(path.join(harness, "private", "secret.txt"), "private");
  commitAll(path.join(harness, "private"));
  commitAll(harness);
  const games = path.join(harness, "games");
  mkdirSync(games);
  const outside = mkdtempSync(path.join(tmpdir(), "anyco-outside-repo-"));
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  commitAll(outside);
  symlinkSync(outside, path.join(games, "linked"));

  for (const repo of ["..", "../private", "linked", outside, "./linked", "Linked", "a/b"]) {
    const ctx = ctxFor(games);
    const r = await IMPLS.game_repo.game_clone.run({ repo }, ctx);
    assert.equal(r.is_error, true, `repo ${JSON.stringify(repo)} must be refused`);
    assert.equal(existsSync(path.join(ctx.workspace, "game")), false, `nothing cloned for ${JSON.stringify(repo)}`);
  }
  // Auto-pick ignores the symlinked entry too: with only "linked" there is no game repo.
  const auto = await IMPLS.game_repo.game_clone.run({}, ctxFor(games));
  assert.equal(auto.is_error, true);
  assert.match(auto.content, /no game repo/);

  // A real repo next to the symlink still works by name and by auto-pick.
  mkdirSync(path.join(games, "realgame"));
  writeFileSync(path.join(games, "realgame", "README.md"), "# real\n");
  commitAll(path.join(games, "realgame"));
  const ok = await IMPLS.game_repo.game_clone.run({}, ctxFor(games));
  assert.equal(ok.is_error, undefined, ok.content);
  assert.equal(JSON.parse(ok.content).game, "realgame");
  const named = await IMPLS.game_repo.game_clone.run({ repo: "realgame" }, ctxFor(games));
  assert.equal(JSON.parse(named.content).game, "realgame");
});

test("game_exec timeout kills the whole process group, including children that ignore SIGTERM", async () => {
  const { root } = makeGamesRoot();
  const ctx = ctxFor(root);
  await IMPLS.game_repo.game_clone.run({}, ctx);
  const marker = `anyco-orphan-probe-${process.pid}-${Date.now()}`;
  const t0 = Date.now();
  const r = await IMPLS.game_repo.game_exec.run(
    { command: ["sh", "-c", `trap '' TERM; (trap '' TERM; sleep 60; : ${marker}) & sleep 60`], timeout_s: 1 },
    ctx,
  );
  assert.equal(r.is_error, true);
  assert.match(r.content, /timed out after 1 s/);
  assert.ok(Date.now() - t0 < 10_000, "returns soon after the timeout");
  await new Promise((res) => setTimeout(res, 2500)); // SIGKILL follows SIGTERM after 2 s
  let left = "";
  try { left = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim(); } catch { /* exit 1 = no match */ }
  assert.equal(left, "", "no child survives");
});

// ---- T28: agent branches continue from origin ----

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const commitIn = async (ctx: ToolContext, file: string, text: string) => {
  await IMPLS.game_repo.game_write.run({ path: file, content: text }, ctx);
  await IMPLS.game_repo.game_exec.run({ command: ["git", "add", "-A"] }, ctx);
  return IMPLS.game_repo.game_exec.run({ command: ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `work ${file}`] }, ctx);
};

test("T28: a reused agent branch: the clone continues from origin's branch, merges main, and the push fast-forwards", async () => {
  const { root } = makeGamesRoot();
  const origin = path.join(root, "testgame");
  // run 1: works and pushes its agent branch
  const run1 = ctxFor(root);
  assert.match(JSON.parse((await IMPLS.game_repo.game_clone.run({}, run1)).content).base, /^main/);
  await commitIn(run1, "src/one.gd", "extends Node # run 1\n");
  assert.equal((await IMPLS.game_repo.game_exec.run({ command: ["git", "push", "-q", "origin", "HEAD"] }, run1)).is_error, false);
  // meanwhile the Tech Lead moves main
  writeFileSync(path.join(origin, "MAIN.md"), "main moved\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-q", "-m", "main moved");
  // run 2: same agent, fresh workspace
  const run2 = ctxFor(root);
  const info = JSON.parse((await IMPLS.game_repo.game_clone.run({}, run2)).content);
  assert.match(info.base, /^origin\/agent\/gameplay-engineer \+ origin\/main merged in/);
  assert.ok(existsSync(path.join(run2.workspace, "game", "src", "one.gd")), "run 1's work is there");
  assert.ok(existsSync(path.join(run2.workspace, "game", "MAIN.md")), "main's latest is there");
  await commitIn(run2, "src/two.gd", "extends Node # run 2\n");
  const push = await IMPLS.game_repo.game_exec.run({ command: ["git", "push", "-q", "origin", "HEAD"] }, run2);
  assert.equal(push.is_error, false, push.content); // fast-forward, no pull needed
  assert.match(gitIn(origin, "log", "--oneline", "agent/gameplay-engineer"), /work src\/two\.gd[\s\S]*work src\/one\.gd/);
});

test("T28: a main merge that conflicts is aborted; the clone stays on origin's branch and says so", async () => {
  const { root } = makeGamesRoot();
  const origin = path.join(root, "testgame");
  const run1 = ctxFor(root);
  await IMPLS.game_repo.game_clone.run({}, run1);
  await commitIn(run1, "README.md", "# agent version\n");
  await IMPLS.game_repo.game_exec.run({ command: ["git", "push", "-q", "origin", "HEAD"] }, run1);
  writeFileSync(path.join(origin, "README.md"), "# main version\n");
  gitIn(origin, "commit", "-q", "-am", "main edits README");
  const run2 = ctxFor(root);
  const info = JSON.parse((await IMPLS.game_repo.game_clone.run({}, run2)).content);
  assert.match(info.base, /conflicted and was aborted/);
  assert.equal(gitIn(path.join(run2.workspace, "game"), "status", "--porcelain"), "", "no half-merged state left behind");
  assert.equal(gitIn(path.join(run2.workspace, "game"), "rev-parse", "HEAD"), gitIn(origin, "rev-parse", "agent/gameplay-engineer"));
});
