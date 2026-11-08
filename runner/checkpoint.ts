// End-of-run checkpoint for runs that worked in the studio's game repo (game_repo capability).
// Agents that hit max_turns or a budget cap stopped before committing (Tech Lead, Gameplay Engineer, Art Director on
// Nov 7), and a fresh run clones from the game repo, so that work was lost unless someone rescued it by hand. Here the
// runner commits whatever is left in the run's clone and pushes it to the agent's own branch. It never pushes main:
// uncommitted work on main moves to a wip/<agent>-<run> branch (the repo's pre-receive hook refuses main for everyone
// but the Tech Lead, and even the Tech Lead's main should only move after green builds).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface CheckpointResult {
  checkpointed: boolean; // a commit was made
  pushed: boolean;
  branch?: string;
  commit?: string;
  note: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

/** Commit and push leftover work in <workspace>/game. Never throws. */
export async function checkpointGameClone(workspace: string, agent: string, runId: string, status: string): Promise<CheckpointResult | null> {
  const clone = path.join(workspace, "game");
  if (!existsSync(path.join(clone, ".git"))) return null;
  const env = { ...process.env, ANYCO_AGENT: agent };
  const id = ["-c", "user.name=any-co harness (auto-checkpoint)", "-c", "user.email=harness@any-co.invalid"];
  try {
    let branch = (await git(clone, ["branch", "--show-current"], env)).out;
    const dirty = (await git(clone, ["status", "--porcelain"], env)).out.length > 0;
    let checkpointed = false;
    if (dirty) {
      if (!branch || branch === "main") {
        branch = `wip/${agent}-${runId}`;
        const b = await git(clone, ["checkout", "-q", "-b", branch], env);
        if (b.code !== 0) return { checkpointed: false, pushed: false, note: `could not create ${branch}: ${b.err}` };
      }
      await git(clone, ["add", "-A"], env);
      const c = await git(clone, [...id, "commit", "-q", "-m", `WIP auto-checkpoint: run ${runId} ended ${status} with uncommitted work`], env);
      if (c.code !== 0) return { checkpointed: false, pushed: false, branch, note: `commit failed: ${c.err}` };
      checkpointed = true;
    }
    if (!branch || branch === "main") return { checkpointed, pushed: false, branch, note: "nothing to push from main (the Tech Lead pushes main itself after green builds)" };
    const p = await git(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], env);
    const commit = (await git(clone, ["rev-parse", "--short", "HEAD"], env)).out;
    if (p.code === 0) return { checkpointed, pushed: true, branch, commit, note: "pushed" };
    // Rejected (origin's branch moved on: non-fast-forward, or a hook refused it). Never force:
    // put the work on its own wip branch so it is on origin somewhere and nothing is overwritten.
    const wip = `wip/${agent}-${runId}`;
    if (branch === wip) return { checkpointed, pushed: false, branch, commit, note: `push failed: ${p.err.slice(0, 300)}` };
    const w = await git(clone, ["push", "-q", "origin", `HEAD:refs/heads/${wip}`], env);
    const why = /non-fast-forward|fetch first|\[rejected\]/.test(p.err) ? "non-fast-forward" : "rejected";
    return w.code === 0
      ? { checkpointed, pushed: true, branch: wip, commit, note: `pushed to ${wip}: origin's ${branch} was ${why} for this run's history (not forced; merge it from ${wip})` }
      : { checkpointed, pushed: false, branch, commit, note: `push failed on ${branch} (${p.err.slice(0, 200)}) and on ${wip} (${w.err.slice(0, 200)})` };
  } catch (e) {
    return { checkpointed: false, pushed: false, note: `checkpoint error: ${(e as Error).message}` };
  }
}
