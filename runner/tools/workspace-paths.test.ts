import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS, resolveInWorkspace } from "./impl.ts";
import type { ToolContext } from "./impl.ts";

// tmpdir() on macOS is itself behind a symlink (/var -> /private/var), so these also cover a workspace
// whose own path is not its realpath.
function setup() {
  const workspace = mkdtempSync(path.join(tmpdir(), "anyco-ws-"));
  const outside = mkdtempSync(path.join(tmpdir(), "anyco-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  const ctx: ToolContext = { workspace, naive: null };
  return { workspace, outside, ctx };
}
const read = (ctx: ToolContext, p: string) => IMPLS.workspace_read.workspace_read.run({ path: p }, ctx);
const write = (ctx: ToolContext, p: string, content = "x") => IMPLS.workspace_write.workspace_write.run({ path: p, content }, ctx);

test("workspace paths: a symlinked dir pointing outside is refused for read and write", async () => {
  const { workspace, outside, ctx } = setup();
  symlinkSync(outside, path.join(workspace, "linked"));
  const r = await read(ctx, "linked/secret.txt");
  assert.equal(r.is_error, true);
  assert.match(r.content, /escapes the workspace/);
  assert.equal((await read(ctx, "linked")).is_error, true);
  const w = await write(ctx, "linked/out.png");
  assert.equal(w.is_error, true);
  assert.equal(existsSync(path.join(outside, "out.png")), false);
  const deep = await write(ctx, "linked/new/dir/out.txt");
  assert.equal(deep.is_error, true);
  assert.equal(existsSync(path.join(outside, "new")), false);
});

test("workspace paths: a symlinked final component is refused, existing or dangling", async () => {
  const { workspace, outside, ctx } = setup();
  symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "f.txt"));
  assert.equal((await read(ctx, "f.txt")).is_error, true);
  assert.equal((await write(ctx, "f.txt", "pwned")).is_error, true);
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
  symlinkSync(path.join(outside, "not-yet.txt"), path.join(workspace, "dangling.txt"));
  const w = await write(ctx, "dangling.txt");
  assert.equal(w.is_error, true);
  assert.match(w.content, /dangling symlink/);
  assert.equal(existsSync(path.join(outside, "not-yet.txt")), false);
});

test("workspace paths: `..` after a symlink is resolved lexically and cannot climb out", async () => {
  const { workspace, outside, ctx } = setup();
  // inside/deep -> outside: "deep/../x" is lexically "<ws>/x", never "<outside>/../x".
  mkdirSync(path.join(workspace, "inside"));
  symlinkSync(outside, path.join(workspace, "inside", "deep"));
  const w = await write(ctx, "inside/deep/../x.txt", "ok");
  assert.equal(w.is_error, undefined);
  assert.equal(readFileSync(path.join(workspace, "inside", "x.txt"), "utf8"), "ok");
  assert.equal(existsSync(path.join(path.dirname(outside), "x.txt")), false);
  assert.throws(() => resolveInWorkspace(workspace, "inside/deep/../../../etc"), /escapes the workspace/);
});

test("workspace paths: a symlink that stays inside the workspace still works", async () => {
  const { workspace, ctx } = setup();
  mkdirSync(path.join(workspace, "real"));
  writeFileSync(path.join(workspace, "real", "a.txt"), "hello");
  symlinkSync(path.join(workspace, "real"), path.join(workspace, "alias"));
  assert.equal((await read(ctx, "alias/a.txt")).content, "hello");
  assert.equal((await write(ctx, "alias/b.txt", "b")).is_error, undefined);
  assert.equal(readFileSync(path.join(workspace, "real", "b.txt"), "utf8"), "b");
});

test("workspace paths: non-existent nested paths still work for writes, also under a missing root", async () => {
  const { workspace, ctx } = setup();
  assert.equal((await write(ctx, "a/b/c/d.txt", "d")).is_error, undefined);
  assert.equal(readFileSync(path.join(workspace, "a", "b", "c", "d.txt"), "utf8"), "d");
  // game_* tools resolve under <workspace>/game before the clone exists; that must not throw.
  const p = resolveInWorkspace(path.join(workspace, "game"), "src/x.ts");
  assert.equal(p, path.join(workspace, "game", "src", "x.ts"));
});

test("workspace paths: game_* tools share the guard", async () => {
  const { workspace, outside, ctx } = setup();
  mkdirSync(path.join(workspace, "game", "assets"), { recursive: true });
  symlinkSync(outside, path.join(workspace, "game", "assets", "linked"));
  const w = await IMPLS.game_repo.game_write.run({ path: "assets/linked/out.png", content: "x" }, ctx);
  assert.equal(w.is_error, true);
  assert.equal(existsSync(path.join(outside, "out.png")), false);
  const r = await IMPLS.game_repo.game_read.run({ path: "assets/linked/secret.txt" }, ctx);
  assert.equal(r.is_error, true);
});
