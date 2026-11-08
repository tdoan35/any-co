// Mechanical art-only merges into a game repo's main (T46, AGENTS.md rule 5): no LLM. An agent/* branch whose changes touch
// only assets/** and art/** (no engine code) is merged in a TEMP clone (never the studio's live checkout), gated with runGate on the
// merged tree, and pushed to the game repo's main only if the merge was clean AND the gate is ok. Every refusal leaves main
// untouched. The push passes the repo's single-merger pre-receive hook with the operator override ANYCO_ALLOW_MAIN=1 — the
// harness's logged path (one ledger decision per merge); agents still cannot move main (game_exec refuses ANYCO_* env).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GAMES_DIR as DEFAULT_GAMES_DIR } from "../../runner/tools/exec-scope.ts";
import { runGate } from "./gate.ts";
import { append as ledgerAppend, LEDGER_FILE } from "../ledger/ledger.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Paths an art-only branch may change: assets (incl. manifest.json and Godot .import/.uid sidecars) and the review gallery. */
export const ART_ONLY = /^(assets\/|art\/)/;
/** T46b: files the engine can load or run are never art, even under assets/ or art/ (scripts, scenes, resources, project config).
 *  Other files under art/ (helper .py, scratch sheets) are inert data: the merge never executes branch files. */
export const ENGINE_CODE = /\.(gd|gdshader|gdextension|cs|tscn|scn|tres|res|godot)$|(^|\/)(export_presets\.cfg|override\.cfg)$/i;
export const AGENT_BRANCH = /^agent\/[a-z0-9][a-z0-9-]{0,60}$/;

export interface ArtMergeOptions {
  dryRun?: boolean;
  runsDir?: string; // where the per-repo lock lives (default <harness>/runs)
  ledgerFile?: string;
  agent?: string; // who asked (ledger attribution), default "harness"
  run_id?: string;
  lockWaitMs?: number; // how long to wait for another merge on the same repo (default 60 s)
}

export interface ArtMergeResult {
  ok: boolean;
  reason?: string;
  branch: string;
  mode?: "fast-forward" | "merge";
  base?: string; // main before
  merged?: string; // main after (or what it would be, on a dry run)
  changed: string[];
  assets?: number;
  gate?: { ok: boolean; failed: string[]; missing: string[]; unlisted: string[]; manifest_errors: string[] };
  dry_run?: boolean;
  attempts?: number;
}

const ID = ["-c", "user.name=any-co harness (art merge)", "-c", "user.email=harness@any-co.invalid"];

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, timeout: 120_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A per-game-repo lock (an exclusive directory with the holder's pid): two harness merges on one repo never overlap. */
async function withRepoLock<T>(runsDir: string, gameDir: string, waitMs: number, fn: () => Promise<T>): Promise<T | "busy"> {
  const dir = path.join(runsDir, "locks");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `art-merge-${path.basename(path.resolve(gameDir))}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), String(process.pid));
      break;
    } catch {
      const holder = Number(existsSync(path.join(lock, "pid")) ? readFileSync(path.join(lock, "pid"), "utf8") : "0");
      if (holder && !pidAlive(holder)) {
        rmSync(lock, { recursive: true, force: true }); // stale: its process is gone
        continue;
      }
      if (Date.now() > deadline) return "busy";
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Merge `branch` of the game repo at `gameDir` into its main, mechanically, if (and only if) it is art-only, clean, and gated ok. */
export async function artMerge(gameDir: string, branch: string, opts: ArtMergeOptions = {}): Promise<ArtMergeResult> {
  const refuse = (reason: string, extra: Partial<ArtMergeResult> = {}): ArtMergeResult => ({ ok: false, reason, branch, changed: [], ...extra });
  if (!AGENT_BRANCH.test(branch)) return refuse(`only agent/<name> branches are merged mechanically, got "${branch}"`);
  if (!existsSync(path.join(gameDir, ".git"))) return refuse(`${gameDir} is not a game repo (no .git)`);
  const runsDir = opts.runsDir ?? path.join(ROOT, "runs");
  const locked = await withRepoLock(runsDir, gameDir, opts.lockWaitMs ?? 60_000, async () => {
    let last: ArtMergeResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = attemptMerge(gameDir, branch, opts, attempt);
      if (r !== "main-moved") return r;
      last = refuse("main moved on the game repo while merging, twice; try again later", { attempts: attempt });
    }
    return last!;
  });
  if (locked === "busy") return refuse("another art merge on this game repo is still running; try again later");
  return locked;
}

function attemptMerge(gameDir: string, branch: string, opts: ArtMergeOptions, attempt: number): ArtMergeResult | "main-moved" {
  const refuse = (reason: string, extra: Partial<ArtMergeResult> = {}): ArtMergeResult => ({ ok: false, reason, branch, changed: [], attempts: attempt, ...extra });
  const tmp = mkdtempSync(path.join(tmpdir(), "art-merge-"));
  try {
    const clone = git(tmp, ["clone", "-q", path.resolve(gameDir), "repo"]);
    if (clone.code !== 0) return refuse(`could not clone ${gameDir}: ${clone.err.slice(0, 300)}`);
    const repo = path.join(tmp, "repo");
    const base = git(repo, ["rev-parse", "origin/main"]);
    if (base.code !== 0) return refuse("the game repo has no main");
    const head = git(repo, ["rev-parse", `origin/${branch}`]);
    if (head.code !== 0) return refuse(`the game repo has no branch ${branch}`);
    const changed = git(repo, ["diff", "--name-only", `origin/main...origin/${branch}`]).out.split("\n").filter(Boolean);
    if (changed.length === 0) return refuse(`${branch} has nothing to merge (no changes against main)`);
    const notArt = changed.filter((p) => !ART_ONLY.test(p) || ENGINE_CODE.test(p));
    if (notArt.length) return refuse(`not art-only: ${notArt.slice(0, 20).join(", ")}${notArt.length > 20 ? ` (+${notArt.length - 20} more)` : ""}`, { changed });

    git(repo, ["checkout", "-q", "-B", "main", "origin/main"]);
    const ff = git(repo, ["merge-base", "--is-ancestor", "origin/main", `origin/${branch}`]).code === 0;
    let mode: ArtMergeResult["mode"];
    if (ff) {
      const m = git(repo, ["merge", "-q", "--ff-only", `origin/${branch}`]);
      if (m.code !== 0) return refuse(`fast-forward failed: ${m.err.slice(0, 300)}`, { changed });
      mode = "fast-forward";
    } else {
      const m = git(repo, [...ID, "merge", "-q", "--no-ff", "-m", `Art merge ${branch} (harness, mechanical: art-only, gate ok)`, `origin/${branch}`]);
      if (m.code !== 0) {
        const conflicts = git(repo, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
        git(repo, ["merge", "--abort"]);
        return refuse(`conflict: ${(conflicts.length ? conflicts : ["(merge failed)"]).join(", ")} → needs a tech-lead card`, { changed });
      }
      mode = "merge";
    }
    const merged = git(repo, ["rev-parse", "HEAD"]).out;

    const report = runGate(repo);
    const gate = {
      ok: report.ok,
      failed: report.assets.filter((a) => !a.pass).map((a) => a.id),
      missing: report.files.missing,
      unlisted: report.files.unlisted,
      manifest_errors: report.manifest.errors,
    };
    const assets = changed.filter((p) => p.startsWith("assets/") && !/\.(import|uid)$/.test(p) && p !== "assets/manifest.json").length;
    if (!report.ok) {
      const parts = [
        gate.failed.length ? `failed: ${gate.failed.slice(0, 15).join(", ")}` : "",
        gate.missing.length ? `missing: ${gate.missing.slice(0, 10).join(", ")}` : "",
        gate.unlisted.length ? `unlisted: ${gate.unlisted.slice(0, 10).join(", ")}` : "",
        gate.manifest_errors.length ? `manifest: ${gate.manifest_errors.slice(0, 3).join("; ")}` : "",
      ].filter(Boolean);
      return refuse(`gate failed on the merged tree (${parts.join("; ")})`, { changed, gate, mode, base: base.out, assets });
    }
    if (opts.dryRun) return { ok: true, branch, mode, base: base.out, merged, changed, assets, gate, dry_run: true, attempts: attempt };

    // Land it: the repo's pre-receive hook guards main; the harness passes it with the logged operator override.
    const env: NodeJS.ProcessEnv = { ...process.env, ANYCO_ALLOW_MAIN: "1" };
    delete env.ANYCO_AGENT;
    const push = git(repo, ["push", "-q", "origin", "HEAD:refs/heads/main"], env);
    if (push.code !== 0) {
      if (/non-fast-forward|fetch first|rejected/i.test(push.err) && attempt === 1) return "main-moved";
      return refuse(`push to the game repo's main failed: ${push.err.slice(0, 300)}`, { changed, gate, mode, base: base.out, assets });
    }
    ledgerAppend({
      kind: "decision", ts: new Date().toISOString(), agent: opts.agent ?? "harness", run_id: opts.run_id ?? "art-merge", topic: "art.merge",
      decision: `merged ${branch} into ${path.basename(path.resolve(gameDir))} main mechanically (${mode}): ${base.out.slice(0, 10)} → ${merged.slice(0, 10)}, ${assets} asset file(s), gate ok`,
      rationale: "Art-only branches (assets/** and art/** only, no engine code/scenes/resources), merged clean in a temp clone, gate ok on the merged tree: no LLM needed (AGENTS.md rule 5).",
      refs: [branch, merged],
    }, opts.ledgerFile ?? LEDGER_FILE);
    return { ok: true, branch, mode, base: base.out, merged, changed, assets, gate, attempts: attempt };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The game repo a run's clone was cloned from (its origin), or null. */
export function gameRepoOfClone(clone: string, gamesRoot: string = process.env.STUDIO_GAMES_DIR ?? DEFAULT_GAMES_DIR): string | null {
  // The clone belongs to an agent run, so its origin is untrusted: read it as DATA from the config file (never run git
  // inside the clone, whose config could run hooks or helpers), and accept only a real repo directly under the games root.
  // Otherwise an agent could point origin at another repo and have the harness push there with ANYCO_ALLOW_MAIN.
  try {
    const cfg = readFileSync(path.join(clone, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/.exec(cfg);
    const url = m?.[1].trim();
    if (!url || !path.isAbsolute(url)) return null;
    const real = realpathSync(url);
    const root = realpathSync(gamesRoot);
    if (path.dirname(real) !== root || !existsSync(path.join(real, ".git"))) return null;
    return real;
  } catch {
    return null;
  }
}
