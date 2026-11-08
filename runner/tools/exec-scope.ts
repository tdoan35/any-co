// game_exec scoping (T40). Agent-run processes (game_exec, and harness spawns that run agent-written code:
// checkpoint git, QA/export/media Godot runs) get:
//   1. a minimal env by ALLOWLIST: no API keys, tokens or studio state paths reach them;
//   2. argv checks: nothing under the harness repo outside the run's clone is executed, package managers
//      cannot walk up from the clone to the harness package.json, shell strings cannot cd above the clone;
//   3. on macOS, a Seatbelt sandbox (sandbox-exec): writes under the harness tree are denied except the clone and
//      the games/ repos (pushes), and the harness .env is unreadable. This is the part a determined agent cannot
//      talk its way around (a script it writes into its clone still runs inside the sandbox).
// Residual risk (documented in docs/decisions.md): without the sandbox (Linux, or ANYCO_EXEC_SANDBOX=off) a script the
// agent writes into its clone can still read files and call harness CLIs by absolute path as the same OS user; the
// env scrub keeps secrets out of its reach and the operator CLIs refuse ANYCO_AGENT, but an `unset` defeats that.
import { existsSync, realpathSync } from "node:fs";
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

/** Env names an agent-run process may see. Everything else (keys, tokens, NAIVE_*, STUDIO_*, …) is dropped. */
export const EXEC_ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR", "TMP", "TEMP",
  "GODOT", "GODOT_BIN", "FFMPEG_BIN", "FFPROBE_BIN", // build.sh reads GODOT
  // Linux display/session for windowed Godot runs; XDG dirs hold Godot's editor data and export templates
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "ANYCO_AGENT",
]);
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * The env for an agent-run child: allowlisted names only (plus LC_*), PATH without entries inside the harness tree
 * (its node_modules/.bin), PWD pinned to the clone, ANYCO_AGENT set. A name that looks secret never passes.
 */
export function execEnv(agent: string, cwd: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (!(EXEC_ENV_ALLOW.has(k) || k.startsWith("LC_")) || SECRETISH.test(k)) continue;
    env[k] = v;
  }
  if (env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((d) => d && !inside(real(path.resolve(d)), HARNESS_ROOT)).join(path.delimiter);
  env.PWD = real(cwd);
  env.ANYCO_AGENT = agent;
  return env;
}

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
    for (let k = 0; k < args.length; k++) {
      const flag = args[k];
      // -c core.hooksPath reaches the origin's receive-pack on a local push and would switch off its single-merger hook
      if ((flag === "-c" && /^core\.hookspath=/i.test(args[k + 1] ?? "")) || /^--config-env=core\.hookspath/i.test(flag))
        return "git -c core.hooksPath is not allowed (it would disable the game repo's hooks)";
      const val = /^--(git-dir|work-tree)=/.test(flag) ? flag.split("=").slice(1).join("=") : ["-C", "--git-dir", "--work-tree"].includes(flag) ? args[k + 1] : null;
      if (val && !inside(resolveArg(val), root)) return `git ${flag.split("=")[0]} outside your clone is not allowed`;
    }
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
    }
  }
  return null;
}

/** macOS Seatbelt profile: deny writes under the harness tree except the clone and games/ (pushes), and hide .env files at its root. */
export function sandboxProfile(clone: string): string {
  const q = (p: string) => JSON.stringify(p);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${q(HARNESS_ROOT)}))`,
    `(allow file-write* (subpath ${q(real(clone))}) (subpath ${q(path.join(HARNESS_ROOT, "games"))}))`,
    `(deny file-read* (regex ${q(`^${HARNESS_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.env`)}))`,
  ].join("\n");
}

/** Whether to wrap agent-run children in sandbox-exec: macOS with /usr/bin/sandbox-exec, unless ANYCO_EXEC_SANDBOX=off. */
export function sandboxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && env.ANYCO_EXEC_SANDBOX !== "off" && existsSync("/usr/bin/sandbox-exec");
}

/** The argv to spawn: sandboxed on macOS, as given elsewhere. */
export function scopedArgv(argv: string[], clone: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return sandboxAvailable(env) ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile(clone), ...argv] : argv;
}
