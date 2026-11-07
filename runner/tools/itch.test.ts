import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";

const BID = "20261107-2115-abc1234";
const KEY = "test-butler-key-never-printed";

// A fake butler: writes its argv to a fixed file, with the behavior each test needs baked into
// the script itself — it cannot read control env vars, because butler gets a minimal env.
const setup = (opts: { fail?: boolean; leak?: boolean } = {}) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "anyco-itch-"));
  const dist = path.join(workspace, "game", "dist");
  mkdirSync(path.join(dist, "web"), { recursive: true });
  writeFileSync(path.join(dist, "build_id"), `${BID}\n`);
  writeFileSync(path.join(dist, "web", "index.html"), "<html></html>");
  const dir = mkdtempSync(path.join(tmpdir(), "anyco-fakebutler-"));
  const argvFile = path.join(dir, "argv");
  const bin = path.join(dir, "fake-butler");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
    opts.fail ? "exit 3" : ":",
    opts.leak ? 'echo "auth: key=$BUTLER_API_KEY" >&2' : ":",
    '[ -n "$NAIVE_API_KEY" ] && echo "NAIVE-KEY-PRESENT-IN-ENV"',
    'echo "fake butler: $*"',
  ].join("\n");
  writeFileSync(bin, script + "\n");
  chmodSync(bin, 0o755);
  return { workspace, argvFile, bin, ctx: { workspace, naive: null, agent: "build-release" } as ToolContext };
};

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const argvOf = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);
const push = (ctx: ToolContext, input: Record<string, unknown>) => IMPLS.itch_push.itch_push.run(input, ctx);
const webReal = (ctx: ToolContext) => realpathSync(path.join(ctx.workspace, "game", "dist", "web"));

test("itch_push: argv shape, dry-run is the default, key never in argv or result", async () => {
  const { ctx, argvFile, bin } = setup();
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, false);
    const argv = argvOf(argvFile);
    assert.deepEqual(argv, ["push", webReal(ctx), "any-co/studio-game:html5", `--userversion=${BID}`, "--dry-run"]);
    assert.ok(!argv.includes(KEY), "key must not appear in argv");
    assert.ok(!out.content.includes(KEY), "key must not appear in results");
  });
});

test("itch_push: dry_run false pushes for real and says so", async () => {
  const { ctx, argvFile, bin } = setup();
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID, dry_run: false });
    assert.equal(out.is_error, false);
    assert.deepEqual(argvOf(argvFile), ["push", webReal(ctx), "any-co/studio-game:html5", `--userversion=${BID}`]);
    assert.match(out.content, /REAL PUSH/);
  });
});

test("itch_push: dir cannot escape the clone's dist/", async () => {
  const { ctx, argvFile, bin } = setup();
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    for (const dir of ["..", "../src", "/etc"]) {
      const out = await push(ctx, { dir, target: "any-co/studio-game:html5", build_id: BID });
      assert.equal(out.is_error, true, dir);
    }
    assert.equal(existsSync(argvFile), false, "butler must not run for refused paths");
  });
});

test("itch_push: build_id must match dist/build_id exactly", async () => {
  const { ctx, argvFile, bin } = setup();
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: "19990101-0000-deadbee" });
    assert.equal(out.is_error, true);
    assert.match(out.content, /build_id mismatch/);
    assert.equal(existsSync(argvFile), false);
  });
});

test("itch_push: missing key or missing binary names exactly what is missing", async () => {
  const { ctx, argvFile, bin } = setup();
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: undefined }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, true);
    assert.match(out.content, /BUTLER_API_KEY/);
    assert.equal(existsSync(argvFile), false);
  });
  await withEnv({ BUTLER_BIN: path.join(path.dirname(bin), "nope-butler"), BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, true);
    assert.match(out.content, /butler failed to start/);
  });
});

test("itch_push: butler's non-zero exit is an error result with the exit code", async () => {
  const { ctx, bin } = setup({ fail: true });
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, true);
    assert.match(out.content, /exit 3/);
  });
});

test("itch_push: a dir that is a symlink out of the clone is refused; dist itself too", async () => {
  const { workspace, argvFile, bin, ctx } = setup();
  const outside = mkdtempSync(path.join(tmpdir(), "anyco-outside-"));
  writeFileSync(path.join(outside, "index.html"), "<html>exfiltrated</html>");
  symlinkSync(outside, path.join(workspace, "game", "dist", "link"));
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const linked = await push(ctx, { dir: "link", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(linked.is_error, true, "symlink out of the clone must be refused");
    const whole = await push(ctx, { dir: ".", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(whole.is_error, true, "dist itself must be refused");
    assert.equal(existsSync(argvFile), false, "butler must not run");
  });
});

test("itch_push: a symlink inside the pushed tree is refused", async () => {
  const { workspace, argvFile, bin, ctx } = setup();
  const outside = mkdtempSync(path.join(tmpdir(), "anyco-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "game", "dist", "web", "secret.txt"));
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, true);
    assert.equal(existsSync(argvFile), false);
  });
});

test("itch_push: butler output is redacted and butler gets a minimal env", async () => {
  const { argvFile, bin, ctx } = setup({ leak: true });
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY, NAIVE_API_KEY: "naive-leak-probe" }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: BID });
    assert.equal(out.is_error, false);
    assert.ok(!out.content.includes(KEY), "the key must never reach the tool result");
    assert.match(out.content, /\*\*\*/);
    assert.ok(!out.content.includes("NAIVE-KEY-PRESENT-IN-ENV"), "butler must not inherit unrelated secrets");
    assert.ok(existsSync(argvFile), "butler ran with its own key");
  });
});

test("itch_push: a build_id that could read as a flag is refused", async () => {
  const { workspace, argvFile, bin, ctx } = setup();
  writeFileSync(path.join(workspace, "game", "dist", "build_id"), "-evil\n");
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await push(ctx, { dir: "web", target: "any-co/studio-game:html5", build_id: "-evil" });
    assert.equal(out.is_error, true);
    assert.match(out.content, /build_id/);
    assert.equal(existsSync(argvFile), false, "butler must not run");
  });
});

test("itch_status: read-only butler status, same key rules", async () => {
  const { argvFile, bin } = setup();
  const nowhere: ToolContext = { workspace: "/nowhere", naive: null };
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: KEY }, async () => {
    const out = await IMPLS.itch_status.itch_status.run({ target: "any-co/studio-game:html5" }, nowhere);
    assert.equal(out.is_error, false);
    assert.deepEqual(argvOf(argvFile), ["status", "any-co/studio-game:html5"]);
  });
  await withEnv({ BUTLER_BIN: bin, BUTLER_API_KEY: undefined }, async () => {
    const out = await IMPLS.itch_status.itch_status.run({ target: "any-co/studio-game:html5" }, nowhere);
    assert.equal(out.is_error, true);
    assert.match(out.content, /BUTLER_API_KEY/);
  });
});
