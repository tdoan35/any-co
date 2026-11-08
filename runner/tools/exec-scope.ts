// Agent-controlled process launches (T40, hardened in T40-fix per R48). EVERY launch that runs agent-written code —
// game_exec, the end-of-run checkpoint git (hooks are agent files), and the qa_harness / media_capture / export-check
// game launches — goes through the same three layers:
//   1. a minimal env by ALLOWLIST: no API keys, tokens or studio state paths reach them;
//   2. argv checks (execRefusal): nothing under the harness repo outside the run's clone is executed, package managers
//      cannot walk up to the harness package.json, shell strings cannot cd above the clone, git -c is an allowlist;
//   3. on macOS, a Seatbelt sandbox (sandbox-exec) over the whole process tree, so a game a QA run spawns is confined
//      too: writes under the harness tree are denied except the run's workspace (and games/ for a push, minus each
//      repo's hooks/config); the harness .env and the user's credential dirs (~/.ssh, ~/.config/gh, …) are unreadable.
// Residual risk (documented in docs/decisions.md): where sandbox-exec is unavailable (Linux — studio 2 on ty-ubuntu —
// or ANYCO_EXEC_SANDBOX=off), only the env scrub and argv refusals apply; a script the agent writes into its clone can
// still read files and call harness CLIs by absolute path as the same OS user after `unset ANYCO_AGENT`. That seat
// needs an OS sandbox (bubblewrap/landlock) or a separate user before T40's integrity guarantees hold there.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = (() => {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
})();

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // a path that doesn't exist yet: resolve its nearest existing parent so symlinked dirs still compare
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
};
const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** The studio's game repos; a sandboxed agent may write here (git push), but not its hooks/config (single-merger rule). */
export const GAMES_DIR = path.join(HARNESS_ROOT, "games");

/** Env names an agent-run process may see. Everything else (keys, tokens, NAIVE_*, STUDIO_*, …) is dropped. */
export const EXEC_ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR", "TMP", "TEMP",
  "GODOT", "GODOT_BIN", "FFMPEG_BIN", "FFPROBE_BIN", // build.sh reads GODOT
  // Linux display/session for windowed Godot runs; XDG dirs hold Godot's editor data and export templates
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XAUTHORITY", // X cookie file path (Xvfb -auth); not a secret value, exempt from SECRETISH below
  "ANYCO_AGENT",
]);
/** Allowlisted names that match SECRETISH but hold a path, not a secret. */
const SECRETISH_EXEMPT = new Set(["XAUTHORITY"]);
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * The env for an agent-run child: allowlisted names only (plus LC_*), PATH without entries inside the harness tree
 * (its node_modules/.bin), PWD pinned to the clone, ANYCO_AGENT set. A name that looks secret never passes.
 */
export function execEnv(agent: string, cwd: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (!(EXEC_ENV_ALLOW.has(k) || k.startsWith("LC_")) || (SECRETISH.test(k) && !SECRETISH_EXEMPT.has(k))) continue;
    env[k] = v;
  }
  if (env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((d) => d && !inside(real(path.resolve(d)), HARNESS_ROOT)).join(path.delimiter);
  env.PWD = real(cwd);
  env.ANYCO_AGENT = agent;
  return env;
}

/** The only `git -c key=…` keys an agent run may set (the checkpoint commit identity); everything else is refused. */
export const GIT_CONFIG_ALLOW = new Set(["user.name", "user.email"]);
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack"]);
const INTERPRETERS = new Set(["node", "nodejs", "tsx", "ts-node", "deno", "bun", "python", "python3", "ruby", "perl", "php"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** The nearest dir at or above `from` holding a package.json (npm's local prefix), or null. */
export function packageRoot(from: string): string | null {
  for (let d = real(from); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "package.json"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Why this argv may not run from `clone`, or null. Checks argv[0] and its arguments for harness files outside the
 * clone, package managers whose project resolves above the clone, git -C/--git-dir/--work-tree outside it, `env`
 * wrappers (recursively; unsetting/overriding ANYCO_AGENT is refused), and shell -c strings that cd above the clone,
 * name harness paths, or run a package manager (its cwd can't be tracked through a shell string).
 */
export function execRefusal(argv: string[], clone: string): string | null {
  const root = real(clone);
  const resolveArg = (a: string) => real(path.resolve(root, a.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")));
  const harnessOutside = (p: string) => inside(p, HARNESS_ROOT) && !inside(p, root);
  const [cmd, ...args] = argv;
  const base = path.basename(cmd);

  if (cmd.includes("/") && harnessOutside(resolveArg(cmd))) return `"${cmd}" is a harness file outside your clone; game_exec runs only your clone's own files and system tools`;

  if (base === "env") {
    let i = 0;
    while (i < args.length && (args[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) {
      if (/^ANYCO_AGENT(=|$)/.test(args[i]) || ((args[i] === "-u" || args[i] === "--unset") && args[i + 1] === "ANYCO_AGENT") || args[i] === "-i" || args[i] === "--ignore-environment")
        return "changing ANYCO_AGENT (or clearing the env) is not allowed: it is how the game repo and operator CLIs tell agent runs apart";
      // T40-fix3: ANYCO_* (e.g. ANYCO_ALLOW_MAIN, the single-merger hook's operator override) and GIT_* (GIT_SSH_COMMAND,
      // GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH, ...) can switch off the game repo's guards or run a shell from git.
      if (GUARDED_ENV.test(args[i])) return `setting ${args[i].split("=")[0]} is not allowed: ANYCO_* and GIT_* variables can bypass the game repo's guards`;
      i += args[i] === "-u" || args[i] === "--unset" || args[i] === "-C" || args[i] === "--chdir" ? 2 : 1;
    }
    if (args.some((a, k) => (a === "-C" || a === "--chdir") && args[k + 1] && !inside(resolveArg(args[k + 1]), root))) return "env -C outside your clone is not allowed";
    return i < args.length ? execRefusal(args.slice(i), clone) : null;
  }

  if (PACKAGE_MANAGERS.has(base)) {
    const pkg = packageRoot(root);
    if (!pkg || !inside(pkg, root))
      return `${base} here would resolve the project above your clone${pkg ? ` (${pkg === HARNESS_ROOT ? "the harness repo" : pkg})` : ""}: run your clone's own scripts (e.g. ["./build.sh", "test"]) or the qa_harness tools`;
    for (let k = 0; k < args.length; k++) {
      const flag = args[k];
      const val = /^--(prefix|dir|cwd)=/.test(flag) ? flag.split("=").slice(1).join("=") : ["--prefix", "-C", "--dir", "--cwd", "-w", "--workspace"].includes(flag) ? args[k + 1] : null;
      if (val && !inside(resolveArg(val), root)) return `${base} ${flag} outside your clone is not allowed`;
    }
  }

  if (base === "git") {
    const why = gitRefusal(args, root, resolveArg);
    if (why) return why;
  }

  if (INTERPRETERS.has(base) || PACKAGE_MANAGERS.has(base)) {
    for (const a of args) {
      if (a.startsWith("-")) continue;
      if ((a.includes("/") || existsSync(path.join(root, a))) && harnessOutside(resolveArg(a))) return `"${a}" is a harness file outside your clone; run your clone's own files only`;
    }
    const evalIdx = args.findIndex((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print" || a === "-c");
    if (evalIdx !== -1 && args[evalIdx + 1] && stringTouchesHarness(args[evalIdx + 1], root)) return "inline code that names a path outside your clone is not allowed";
  }

  if (SHELLS.has(base)) {
    const cIdx = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (cIdx !== -1) {
      const script = args[cIdx + 1] ?? "";
      const why = shellRefusal(script, root);
      if (why) return why;
    } else {
      const file = args.find((a) => !a.startsWith("-"));
      if (file && harnessOutside(resolveArg(file))) return `"${file}" is a harness file outside your clone; run your clone's own scripts only`;
    }
  }
  return null;
}

/** Variables an agent may not set through `env` or a shell string (T40-fix3): ANYCO_* guard switches and GIT_* hooks. */
const GUARDED_ENV = /^(ANYCO_[A-Za-z0-9_]*|GIT_[A-Za-z0-9_]*)=/;
/** git options that name a program for git to run (on either end of a push/fetch): a shell by another name (T40-fix3). */
const GIT_PROGRAM_FLAGS = ["--receive-pack", "--upload-pack", "--exec"];

/** Why a git argv (after `git`) may not run from `root`, or null: -c outside the allowlist, -C/--git-dir/--work-tree
 * outside the clone, or a pack/exec program override (`git push --receive-pack='git -c core.hooksPath=/dev/null …'`). */
function gitRefusal(args: string[], root: string, resolveArg: (a: string) => string): string | null {
  const sub = args.find((a, k) => !a.startsWith("-") && !["-c", "-C", "--git-dir", "--work-tree", "--config-env"].includes(args[k - 1] ?? ""));
  for (let k = 0; k < args.length; k++) {
    const flag = args[k];
    // `git -c key=value` can run a shell (alias.x=!cmd, core.sshCommand, core.pager, core.fsmonitor,
    // credential.helper) or disable the game repo's single-merger hook (core.hooksPath), so allow only two keys.
    if (flag === "-c" || flag === "--config-env" || flag.startsWith("--config-env=")) {
      const spec = flag.startsWith("--config-env=") ? flag.slice("--config-env=".length) : (args[k + 1] ?? "");
      const key = spec.split("=")[0]!.toLowerCase();
      if (flag !== "-c" || !GIT_CONFIG_ALLOW.has(key)) return `git ${flag.split("=")[0]} ${spec} is not allowed; only ${[...GIT_CONFIG_ALLOW].join(", ")} may be set with git -c`;
    }
    const prog = GIT_PROGRAM_FLAGS.find((f) => flag === f || flag.startsWith(f + "="));
    if (prog || (flag === "-u" && sub === "clone")) return `git ${prog ?? "clone -u"} is not allowed: it names a program for git to run`;
    const val = /^--(git-dir|work-tree)=/.test(flag) ? flag.split("=").slice(1).join("=") : ["-C", "--git-dir", "--work-tree"].includes(flag) ? args[k + 1] : null;
    if (val && !inside(resolveArg(val), root)) return `git ${flag.split("=")[0]} outside your clone is not allowed`;
  }
  return null;
}

/** An inline program string that names the harness root, an absolute path outside the clone, or ../ escaping it. */
function stringTouchesHarness(code: string, root: string): boolean {
  if (code.includes(HARNESS_ROOT)) return true;
  for (const m of code.matchAll(/(?:^|[\s"'`=(])((?:\.\.\/)+[^\s"'`;)]*|\.\.(?=$|[\s"'`;)]))/g)) {
    if (!inside(real(path.resolve(root, m[1])), root)) return true;
  }
  return false;
}

/** Why a `sh -c` string may not run: cd above the clone, a harness path, a package manager, or ANYCO_AGENT changes. */
export function shellRefusal(script: string, root: string): string | null {
  if (/\b(unset|export|readonly|declare|typeset)\s+(-\w+\s+)*ANYCO_AGENT\b|\bANYCO_AGENT\s*=|-u\s*ANYCO_AGENT\b|\benv\s+(-\w+\s+)*-i\b/.test(script))
    return "a shell string may not change or clear ANYCO_AGENT";
  if (/(^|[\s;&|(`])(export\s+(-\w+\s+)*)?(ANYCO_[A-Za-z0-9_]*|GIT_[A-Za-z0-9_]*)\s*=/.test(script))
    return "a shell string may not set ANYCO_* or GIT_* variables (they can bypass the game repo's guards)";
  if (stringTouchesHarness(script, root)) return "a shell string that names a path outside your clone (../ or the harness repo) is not allowed";
  for (const seg of script.split(/[;&|\n()`]+/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    for (let k = 0; k < words.length; k++) {
      const w = words[k].replace(/^["']|["']$/g, "");
      if ((w === "cd" || w === "pushd") && words[k + 1] !== undefined) {
        const target = words[k + 1].replace(/^["']|["']$/g, "");
        if (/^[~$]/.test(target) || target.startsWith("/") || !inside(real(path.resolve(root, target)), root))
          return `a shell string may not cd outside your clone (cd ${target})`;
      }
      if ((w === "cd" || w === "pushd") && words[k + 1] === undefined) return "a bare cd (to $HOME) leaves your clone";
      if (PACKAGE_MANAGERS.has(path.basename(w))) return `run ${path.basename(w)} as its own game_exec argv (not inside a shell string), so its project can be checked`;
      if (path.basename(w) === "git") {
        const why = gitRefusal(words.slice(k + 1).map((x) => x.replace(/^["']|["']$/g, "")), root, (a) => real(path.resolve(root, a)));
        if (why) return why;
      }
    }
  }
  return null;
}

/** Credential files a sandboxed agent run may not read, so a planted script cannot grab gh/ssh/aws tokens. */
export function credentialReadDenies(home = process.env.HOME || homedir()): string[] {
  const h = real(home);
  return [".ssh", ".config/gh", ".config/git", ".aws", ".netrc", ".git-credentials"].map((p) => path.join(h, p));
}

/** Mach services the macOS keychain answers on; a sandboxed agent run may not look them up (T40-fix3). */
export const KEYCHAIN_MACH_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"];

const sbQuote = (p: string) => JSON.stringify(p);
const sbRegex = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * macOS Seatbelt profile for an agent-run child and its descendants (T40): writes under the harness tree are denied
 * except `writeRoots` (the run's workspace, or the clone + games/ for a push); even within games/ a repo's hooks and
 * config stay read-only (the single-merger hook can't be rewritten); the harness `.env*` and the user's credential
 * directories (~/.ssh, ~/.config/gh, ~/.aws, …) are unreadable. Reads elsewhere and the writable roots are allowed.
 */
export function sandboxProfile(writeRoots: string[]): string {
  const roots = writeRoots.map((r) => real(r));
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sbQuote(HARNESS_ROOT)}))`,
    `(allow file-write* ${roots.map((r) => `(subpath ${sbQuote(r)})`).join(" ")})`,
    // a game repo under games/ stays writable for push objects/refs, but its hooks and config do not (R48 #6)
    `(deny file-write* (regex #"/games/[^/]+/(\\.git/)?hooks(/|$)") (regex #"/games/[^/]+/(\\.git/)?config$"))`,
    `(deny file-read* (regex #"^${sbRegex(HARNESS_ROOT)}/\\.env"))`,
    `(deny file-read* ${credentialReadDenies().map((d) => `(subpath ${sbQuote(d)})`).join(" ")})`,
    // T40-fix3: the login keychain (Ty's GitHub credential via git credential-osxkeychain) is reached over these
    // Mach services, not files; denying them leaves Godot, ffmpeg and https git without a stored credential.
    `(deny mach-lookup ${KEYCHAIN_MACH_SERVICES.map((n) => `(global-name ${sbQuote(n)})`).join(" ")})`,
  ];
  return lines.join("\n");
}

/** Whether to wrap agent-run children in sandbox-exec: macOS with /usr/bin/sandbox-exec, unless ANYCO_EXEC_SANDBOX=off. */
export function sandboxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && env.ANYCO_EXEC_SANDBOX !== "off" && existsSync("/usr/bin/sandbox-exec");
}

/**
 * The argv to spawn for an agent-run child: sandbox-exec on macOS (the whole process tree is confined, so a game a QA
 * run spawns is confined too), or the argv as given where no sandbox is available (Linux: the env scrub and argv
 * refusals still apply; see docs/decisions.md for the residual risk). `writeRoots` are the dirs it may write.
 */
export function scopedArgv(argv: string[], writeRoots: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (sandboxAvailable(env)) return ["/usr/bin/sandbox-exec", "-p", sandboxProfile(writeRoots), ...argv];
  warnUnsandboxed(env);
  return argv;
}

let warnedUnsandboxed = false;
/** Once per process: say loudly that agent-run children are NOT OS-sandboxed here (Linux, or ANYCO_EXEC_SANDBOX=off).
 * A warning, not a refusal (T40-fix3): studio 2 on Linux must keep building; the gap is accepted and documented. */
export function warnUnsandboxed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (warnedUnsandboxed || sandboxAvailable(env)) return false;
  warnedUnsandboxed = true;
  const why = process.platform !== "darwin" ? `no OS sandbox on ${process.platform}` : "ANYCO_EXEC_SANDBOX=off";
  console.warn(`[exec-scope] WARNING: agent-run processes are NOT sandboxed (${why}). Only the env scrub and argv refusals apply; a script an agent writes into its clone can read files and call harness CLIs as this OS user. See docs/decisions.md (T40).`);
  return true;
}

/** The sandbox-exec prefix to prepend to a launch argv (empty where no sandbox): for spawns the runner builds itself (media_capture). */
export function sandboxPrefix(writeRoots: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (sandboxAvailable(env)) return ["/usr/bin/sandbox-exec", "-p", sandboxProfile(writeRoots)];
  warnUnsandboxed(env);
  return [];
}
