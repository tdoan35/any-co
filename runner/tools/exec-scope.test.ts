// T40: game_exec scoping. Env allowlist, harness isolation (argv), the macOS sandbox, and operator CLIs that refuse
// agent-started processes. Clones that must sit INSIDE the harness tree (like a real run's runs/<id>/workspace/game)
// are made under runs/ (gitignored) and removed afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GIT_CONFIG_ALLOW, HARNESS_ROOT, KEYCHAIN_MACH_SERVICES, credentialReadDenies, execEnv, execRefusal, packageRoot, sandboxAvailable, sandboxPrefix, sandboxProfile } from "./exec-scope.ts";
import { IMPLS, type ToolContext } from "./impl.ts";

/** A workspace whose game/ clone sits inside the harness tree (runs/…), as a real run's does. */
function harnessWorkspace(): { ws: string; clone: string; cleanup: () => void } {
  mkdirSync(path.join(HARNESS_ROOT, "runs"), { recursive: true }); // runs/ is gitignored and may be absent in a fresh checkout (R48 #7)
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
      // R48 #3: git -c is an allowlist (only the commit identity), so none of these can run a shell or disable the hook
      [["git", "-c", "core.hooksPath=/dev/null", "push", "origin", "main"], /git -c core\.hooksPath=\/dev\/null is not allowed/],
      [["git", "-c", "alias.x=!sh -c 'id'", "x"], /git -c alias\.x=.* is not allowed/],
      [["git", "-c", "core.sshCommand=/tmp/x", "fetch"], /is not allowed; only user\.name, user\.email/],
      [["git", "-c", "core.pager=/tmp/x", "log"], /is not allowed/],
      [["git", "-c", "credential.helper=/tmp/x", "fetch"], /is not allowed/],
      [["python3", "-c", `open("${HARNESS_ROOT}/runs/ledger.jsonl","a")`], /inline code that names a path outside your clone/],
    ];
    for (const [argv, re] of refused) {
      const r = await exec(ws, argv);
      assert.equal(r.is_error, true, JSON.stringify(argv));
      assert.match(r.content, re, JSON.stringify(argv));
    }
    // legitimate work in the clone still runs, including the checkpoint's own git -c commit identity
    for (const argv of [["./build.sh", "test"], ["bash", "build.sh", "test"], ["git", "--version"], ["git", "-c", "user.name=x", "-c", "user.email=y@z", "commit", "-m", "x"], ["sh", "-c", "echo agent=$ANYCO_AGENT && ls"], ["env", "FOO=1", "./build.sh", "test"]]) {
      assert.equal(execRefusal(argv, clone), null, JSON.stringify(argv));
    }
    assert.deepEqual([...GIT_CONFIG_ALLOW].sort(), ["user.email", "user.name"]);
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

test("T40 profile: writes under the harness are denied except the write roots; games hooks/config and credential dirs are protected", () => {
  const profile = sandboxProfile(["/tmp/run/workspace", path.join(HARNESS_ROOT, "games")]);
  assert.match(profile, new RegExp(`deny file-write\\* \\(subpath "${HARNESS_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
  assert.match(profile, /allow file-write\* \(subpath "[^"]*\/run\/workspace"\) \(subpath ".*\/games"\)/);
  // R48 #6: a game repo stays writable for push objects/refs, but its hooks and config do not
  assert.match(profile, /deny file-write\* \(regex #"\/games\/\[\^\/\]\+\/\(\\\.git\/\)\?hooks\(\/\|\$\)"\) \(regex #"\/games\/\[\^\/\]\+\/\(\\\.git\/\)\?config\$"\)/);
  assert.match(profile, /deny file-read\* \(regex #"\^.*\/\\\.env"\)/, ".env* at the harness root is unreadable");
  // R48 #5: the user's credential dirs cannot be read, so a planted script cannot grab gh/ssh/aws tokens
  for (const d of [".ssh", ".config/gh", ".aws", ".netrc"]) assert.ok(credentialReadDenies("/Users/x").includes(path.join("/Users/x", d)), d);
  assert.match(profile, /deny file-read\* \(subpath ".*\/\.ssh"\)/);
});

test("T40 sandbox (macOS): a clone script launched through QA, media, or game_exec cannot write the harness tree or forge a ledger", { skip: !sandboxAvailable() && "sandbox-exec is macOS-only" }, async () => {
  const { ws, clone, cleanup } = harnessWorkspace();
  const marker = path.join(HARNESS_ROOT, "runs", `t40-probe-${process.pid}.marker`);
  // one clone script that attempts a single harness write; every launch path must have the sandbox deny it
  writeFileSync(path.join(clone, "probe.sh"), `#!/bin/sh\necho x > "${marker}" 2>/dev/null && echo HARNESS-WRITTEN || echo harness-write-denied\necho ok > inside.txt && echo clone-write-ok\nexit 0\n`);
  chmodSync(path.join(clone, "probe.sh"), 0o755);
  try {
    // game_exec
    const ge = await exec(ws, ["./probe.sh"]);
    assert.match(ge.content, /harness-write-denied/);
    assert.match(ge.content, /clone-write-ok/, "the clone itself stays writable");
    assert.equal(existsSync(marker), false, "game_exec: no harness write");

    // qa_smoke launch (R48 #1): the engine binary is the clone script; the sandbox wraps the whole QA subprocess tree
    writeFileSync(path.join(clone, "project.godot"), "[application]\n");
    const qa = await IMPLS.qa_harness.qa_smoke.run({ cmd: ["./probe.sh"], seed: 1, ticks: 1, ack_timeout_ms: 1500, end_wait_ms: 1500 }, ctxFor(ws));
    assert.match(qa.content, /Operation not permitted|ready ack/, qa.content); // the script died denied; the QA run reports it
    assert.equal(existsSync(marker), false, "qa_smoke launch: no harness write");
    assert.equal(existsSync(path.join(HARNESS_ROOT, "runs", "ledger.jsonl")), false, "no forged ledger at the harness root");
  } finally {
    rmSync(marker, { force: true });
    cleanup();
  }
});

test("T40 media: the runner hands media_capture a sandbox prefix so the game and its children are confined", () => {
  const prefix = sandboxPrefix(["/tmp/run/workspace"]);
  if (sandboxAvailable()) {
    assert.equal(prefix[0], "/usr/bin/sandbox-exec");
    assert.equal(prefix[1], "-p");
    assert.match(prefix[2], /allow file-write\* \(subpath "[^"]*\/run\/workspace"\)/);
  } else {
    assert.deepEqual(prefix, [], "no sandbox off macOS");
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

test("T40-fix3: git program overrides, ANYCO_*/GIT_* env routes and git checks inside shell strings are refused; ordinary git still runs", () => {
  const { clone, cleanup } = harnessWorkspace();
  try {
    const refused: Array<[string[], RegExp]> = [
      // R48b's live single-merger bypasses
      [["git", "push", "--receive-pack=git -c core.hooksPath=/dev/null receive-pack", "origin", "HEAD:main"], /names a program for git to run/],
      [["git", "push", "--receive-pack", "git -c core.hooksPath=/dev/null receive-pack", "origin", "HEAD:main"], /names a program for git to run/],
      [["git", "push", "--exec=sh", "origin"], /names a program for git to run/],
      [["git", "fetch", "--upload-pack=sh -c id", "origin"], /names a program for git to run/],
      [["git", "clone", "-u", "sh -c id", "../x", "y"], /names a program for git to run/],
      [["env", "ANYCO_ALLOW_MAIN=1", "git", "push", "origin", "HEAD:main"], /setting ANYCO_ALLOW_MAIN is not allowed/],
      [["env", "GIT_SSH_COMMAND=sh -c id", "git", "push"], /setting GIT_SSH_COMMAND is not allowed/],
      [["env", "GIT_CONFIG_PARAMETERS='core.hooksPath'='/dev/null'", "git", "push"], /setting GIT_CONFIG_PARAMETERS is not allowed/],
      [["git", "--config-env=core.hooksPath=HP", "push"], /--config-env .* is not allowed/],
      [["git", "--config-env", "core.hooksPath=HP", "push"], /--config-env .* is not allowed/],
      // the same routes through a shell string
      [["sh", "-c", "ANYCO_ALLOW_MAIN=1 git push origin HEAD:main"], /may not set ANYCO_\* or GIT_\*/],
      [["bash", "-c", "export GIT_SSH_COMMAND='sh -c id'; git push"], /may not set ANYCO_\* or GIT_\*/],
      [["sh", "-c", "git -c core.hooksPath=/dev/null push origin HEAD:main"], /git -c core\.hooksPath=\/dev\/null is not allowed/],
      [["sh", "-c", "./build.sh test && git push --receive-pack=x origin HEAD:main"], /names a program for git to run/],
    ];
    for (const [argv, why] of refused) {
      const r = execRefusal(argv, clone);
      assert.ok(r && why.test(r), `${JSON.stringify(argv)} should be refused (${why}), got: ${r}`);
    }
    const allowed: string[][] = [
      ["git", "push", "-u", "origin", "agent/tech-lead"], // -u is --set-upstream for push, not --upload-pack
      ["git", "-c", "user.name=tech-lead", "-c", "user.email=t@l", "commit", "-m", "x"],
      ["git", "status"],
      ["sh", "-c", "./build.sh test && git add -A && git commit -m wip"],
      ["env", "LANG=C", "./build.sh", "test"],
      ["sh", "-c", "echo MY_GIT_NOTE=1"], // not a GIT_* assignment
    ];
    for (const argv of allowed) assert.equal(execRefusal(argv, clone), null, `${JSON.stringify(argv)} should be allowed`);
  } finally {
    cleanup();
  }
});

test("T40-fix3 profile: the keychain Mach services are denied", () => {
  const prof = sandboxProfile([HARNESS_ROOT]);
  for (const n of KEYCHAIN_MACH_SERVICES) assert.ok(prof.includes(`(global-name "${n}")`), n);
  assert.match(prof, /\(deny mach-lookup /);
});

test("T40-fix3 sandbox (macOS): keychain lookups fail inside the sandbox; godot and https git still work", { skip: !sandboxAvailable() && "sandbox-exec is macOS-only" }, () => {
  const pre = sandboxPrefix([tmpdir()]);
  // a keychain read through the Security framework fails (no secret is ever printed: stdout is discarded)
  const kc = spawnSync(pre[0]!, [...pre.slice(1), "/usr/bin/security", "find-internet-password", "-s", "github.com"], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  assert.notEqual(kc.status, 0, "security find-internet-password must fail in the sandbox");
  const cred = spawnSync(pre[0]!, [...pre.slice(1), "git", "credential-osxkeychain", "get"], { input: "protocol=https\nhost=github.com\n\n", stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
  assert.equal((cred.stdout ?? "").includes("password="), false, "no keychain password reaches a sandboxed process");
  const godotBin = process.env.GODOT_BIN || spawnSync("sh", ["-c", "command -v godot"], { encoding: "utf8" }).stdout.trim();
  if (godotBin) {
    const g = spawnSync(pre[0]!, [...pre.slice(1), godotBin, "--headless", "--version"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(g.status, 0, `godot --version must still run sandboxed: ${g.stderr}`);
  }
});
