// T40: game_exec scoping. Env allowlist, harness isolation (argv), the macOS sandbox, and operator CLIs that refuse
// agent-started processes. Clones that must sit INSIDE the harness tree (like a real run's runs/<id>/workspace/game)
// are made under runs/ (gitignored) and removed afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HARNESS_ROOT, execEnv, execRefusal, packageRoot, sandboxAvailable, sandboxProfile } from "./exec-scope.ts";
import { IMPLS, type ToolContext } from "./impl.ts";

/** A workspace whose game/ clone sits inside the harness tree (runs/…), as a real run's does. */
function harnessWorkspace(): { ws: string; clone: string; cleanup: () => void } {
  const base = mkdtempSync(path.join(HARNESS_ROOT, "runs", "t40-test-"));
  const ws = path.join(base, "workspace");
  const clone = path.join(ws, "game");
  mkdirSync(clone, { recursive: true });
  writeFileSync(path.join(clone, "build.sh"), '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\ncase "${1:-}" in\n  test) mkdir -p dist && echo ok > dist/build_id && echo "test: green";;\n  *) echo "unknown target" >&2; exit 2;;\nesac\n');
  chmodSync(path.join(clone, "build.sh"), 0o755);
  return { ws, clone, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const ctxFor = (ws: string): ToolContext => ({ workspace: ws, naive: null, runsDir: path.dirname(ws), run_id: "t40", agent: "gameplay-engineer" });
const exec = (ws: string, command: string[]) => IMPLS.game_repo.game_exec.run({ command, timeout_s: 60 }, ctxFor(ws));

test("T40 env: an allowlist (PATH, HOME, locale, Godot/ffmpeg bins, ANYCO_AGENT); no keys, tokens, NAIVE_*/STUDIO_*", () => {
  const parent = {
    PATH: [path.join(HARNESS_ROOT, "node_modules", ".bin"), "/usr/bin", "/bin"].join(path.delimiter), HOME: "/Users/x", LANG: "en_US.UTF-8", LC_ALL: "C",
    GODOT: "/opt/godot", GODOT_BIN: "/opt/godot", TMPDIR: "/tmp/",
    OPENAI_API_KEY: "sk-1", NAIVE_API_KEY: "n", PIXELLAB_API_KEY: "p", RETRO_DIFFUSION_API_KEY: "r", BUTLER_API_KEY: "b", NEON_AI_API_KEY: "ne",
    STUDIO_RUNS_DIR: "/x", STUDIO_LEDGER_FILE: "/x/l", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", NAIVE_BASE_URL: "u", ANYCO_AGENT: "forged",
  };
  const env = execEnv("qa-lead", "/tmp", parent);
  assert.deepEqual(Object.keys(env).sort(), ["ANYCO_AGENT", "GODOT", "GODOT_BIN", "HOME", "LANG", "LC_ALL", "PATH", "PWD", "TMPDIR"]);
  assert.equal(env.ANYCO_AGENT, "qa-lead", "the runner sets it; a parent value never passes through");
  assert.equal(env.PATH, ["/usr/bin", "/bin"].join(path.delimiter), "the harness node_modules/.bin is not on PATH");
});

test("T40 env: a probe inside game_exec sees no secrets", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "t40-env-"));
  mkdirSync(path.join(ws, "game"));
  const prev = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: "sk-probe-secret", NAIVE_API_KEY: "naive-probe-secret", PIXELLAB_API_KEY: "pl-probe-secret" });
  try {
    const r = await exec(ws, ["env"]);
    assert.equal(r.is_error, false, r.content);
    assert.doesNotMatch(r.content, /probe-secret|_API_KEY|NAIVE_|STUDIO_/);
    assert.match(r.content, /ANYCO_AGENT=gameplay-engineer/);
  } finally {
    for (const k of ["OPENAI_API_KEY", "NAIVE_API_KEY", "PIXELLAB_API_KEY"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test("T40 isolation: harness files, harness npm scripts (walk-up), cd above the clone, ANYCO_AGENT changes and hook overrides are refused", async () => {
  const { ws, clone, cleanup } = harnessWorkspace();
  try {
    assert.equal(packageRoot(clone), HARNESS_ROOT, "npm from a clone with no package.json walks up to the harness");
    const refused: Array<[string[], RegExp]> = [
      [["npm", "run", "ledger", "--", "intervention", "x", "y"], /resolve the project above your clone \(the harness repo\)/],
      [["npx", "tsx", "tools/ledger/ledger.ts"], /above your clone/],
      [["node", "../../../../tools/ledger/ledger.ts", "list"], /harness file outside your clone/],
      [["node", path.join(HARNESS_ROOT, "tools", "approvals", "approvals.ts"), "approve", "x"], /harness file outside your clone/],
      [[path.join(HARNESS_ROOT, "node_modules", ".bin", "tsx"), "x.ts"], /harness file outside your clone/],
      [["sh", "-c", "cd .. && npm run ledger -- list"], /outside your clone/],
      [["bash", "-lc", "cd / && ls"], /may not cd outside your clone \(cd \/\)/],
      [["sh", "-c", "cd ~ && ls"], /may not cd outside your clone/],
      [["sh", "-c", "npm test"], /as its own game_exec argv/],
      [["sh", "-c", "unset ANYCO_AGENT; ./build.sh test"], /may not change or clear ANYCO_AGENT/],
      [["env", "-u", "ANYCO_AGENT", "./build.sh", "test"], /changing ANYCO_AGENT/],
      [["env", "ANYCO_AGENT=tech-lead", "git", "push"], /changing ANYCO_AGENT/],
      [["env", "-i", "./build.sh"], /clearing the env/],
      [["env", "FOO=1", "node", "../../../../tools/ledger/ledger.ts"], /harness file outside your clone/],
      [["git", "-C", "../../../..", "status"], /git -C outside your clone/],
      [["git", "--git-dir=../../../../.git", "log"], /git --git-dir outside your clone/],
      [["git", "-c", "core.hooksPath=/dev/null", "push", "origin", "main"], /core\.hooksPath is not allowed/],
      [["python3", "-c", `open("${HARNESS_ROOT}/runs/ledger.jsonl","a")`], /inline code that names a path outside your clone/],
    ];
    for (const [argv, re] of refused) {
      const r = await exec(ws, argv);
      assert.equal(r.is_error, true, JSON.stringify(argv));
      assert.match(r.content, re, JSON.stringify(argv));
    }
    // legitimate work in the clone still runs
    for (const argv of [["./build.sh", "test"], ["bash", "build.sh", "test"], ["git", "--version"], ["sh", "-c", "echo agent=$ANYCO_AGENT && ls"], ["env", "FOO=1", "./build.sh", "test"]]) {
      assert.equal(execRefusal(argv, clone), null, JSON.stringify(argv));
    }
    const ok = await exec(ws, ["./build.sh", "test"]);
    assert.equal(ok.is_error, false, ok.content);
    assert.match(ok.content, /test: green/);
    assert.equal(readFileSync(path.join(clone, "dist", "build_id"), "utf8").trim(), "ok", "the build writes inside its clone");
    // a clone with its own package.json may use npm on it
    writeFileSync(path.join(clone, "package.json"), JSON.stringify({ name: "game", scripts: { t: "echo game-script" } }));
    assert.equal(execRefusal(["npm", "run", "t"], clone), null);
    assert.match(execRefusal(["npm", "--prefix", "../../../..", "run", "ledger"], clone)!, /--prefix outside your clone/);
  } finally {
    cleanup();
  }
});

test("T40 sandbox (macOS): a script the agent writes into its clone cannot write the harness tree or read its .env", { skip: !sandboxAvailable() && "sandbox-exec is macOS-only" }, async () => {
  const { ws, clone, cleanup } = harnessWorkspace();
  const probe = path.join(HARNESS_ROOT, "runs", `t40-ledger-probe-${process.pid}.jsonl`);
  try {
    writeFileSync(path.join(clone, "sneaky.sh"), `#!/bin/sh\nunset ANYCO_AGENT\necho fake >> "${probe}" && echo HARNESS-WRITTEN || echo harness-write-denied\necho x > inside.txt && echo clone-write-ok\n`);
    chmodSync(path.join(clone, "sneaky.sh"), 0o755);
    const r = await exec(ws, ["./sneaky.sh"]);
    assert.match(r.content, /harness-write-denied/);
    assert.match(r.content, /clone-write-ok/);
    assert.equal(existsSync(probe), false);
    const profile = sandboxProfile(clone);
    assert.match(profile, new RegExp(`deny file-write\\* \\(subpath "${HARNESS_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
    assert.match(profile, /\(allow file-write\* \(subpath ".*\/workspace\/game"\) \(subpath ".*\/games"\)\)/, "the clone and the game repos (pushes) stay writable");
    assert.match(profile, /deny file-read\* \(regex/, ".env files at the harness root are unreadable");
  } finally {
    rmSync(probe, { force: true });
    cleanup();
  }
});

test("T40 ledger/approvals CLIs refuse operator writes from a process an agent started", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t40-cli-"));
  const ledger = path.join(dir, "ledger.jsonl");
  const tsx = ["--import", "tsx"];
  const run = (script: string, args: string[], agent?: string) =>
    spawnSync(process.execPath, [...tsx, path.join(HARNESS_ROOT, script), ...args], {
      cwd: HARNESS_ROOT, encoding: "utf8",
      env: { ...process.env, STUDIO_LEDGER_FILE: ledger, STUDIO_APPROVALS_FILE: path.join(dir, "approvals.jsonl"), ...(agent ? { ANYCO_AGENT: agent } : { ANYCO_AGENT: "" }) },
    });
  const iv = run("tools/ledger/ledger.ts", ["intervention", "fake operator action", "fake reason"], "art-director");
  assert.equal(iv.status, 2, iv.stderr);
  assert.match(iv.stderr, /operator command .* started by agent "art-director"/);
  assert.equal(existsSync(ledger), false, "nothing written");
  assert.equal(run("tools/ledger/ledger.ts", ["recategorize", "--apply"], "tech-lead").status, 2);
  const ap = run("tools/approvals/approvals.ts", ["approve", "apr_x"], "art-director");
  assert.equal(ap.status, 2, ap.stderr);
  assert.match(ap.stderr, /operator command/);
  assert.equal(run("tools/approvals/approvals.ts", ["list"], "art-director").status, 0, "read-only listing still works");
  const human = run("tools/ledger/ledger.ts", ["intervention", "real operator action", "real reason"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(readFileSync(ledger, "utf8"), /real operator action/);
});
