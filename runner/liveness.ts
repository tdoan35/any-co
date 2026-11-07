// Run liveness for crash recovery (AGENTS.md rule 7). run.json carries pid/host/heartbeat_at;
// a run stuck at status "running" is orphaned when its heartbeat is stale or, on this host,
// its pid is gone. Deterministic code only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export interface RunFileLike {
  status?: unknown;
  pid?: unknown;
  host?: unknown;
  heartbeat_at?: unknown;
}

/** Is a pid a live process on this machine? EPERM means alive but owned by someone else. */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

export const DEFAULT_ORPHAN_AFTER_MIN = 10;

/** Heartbeat staleness threshold in minutes; `STUDIO_ORPHAN_AFTER_MIN` overrides. */
export function orphanAfterMin(): number {
  const v = Number(process.env.STUDIO_ORPHAN_AFTER_MIN);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ORPHAN_AFTER_MIN;
}

export interface OrphanVerdict {
  orphaned: boolean;
  /** Human-facing reason when orphaned; recorded as the resume reason. */
  reason?: string;
  heartbeat_age_min?: number;
}

/**
 * A run is orphaned when its status is "running" and it is provably not executing: on this
 * host, a live pid means the run is alive even with a stale heartbeat (a long tool call or an
 * approval wait can outlast the threshold — refusing to resume is the safe side, and pid
 * reuse only ever causes a false "alive"). Otherwise a heartbeat older than the threshold,
 * or a dead pid on this host, means orphaned. Pids are per-host: a run from another host
 * (shared runs dir) is judged by heartbeat only. Finished runs are never orphaned; runs with
 * no liveness fields at all are judged by the heartbeat (missing = stale), so old-format runs
 * still get caught.
 */
export function orphanStatus(run: RunFileLike, now = new Date()): OrphanVerdict {
  if (run.status !== "running") return { orphaned: false };
  const hb = typeof run.heartbeat_at === "string" ? Date.parse(run.heartbeat_at) : NaN;
  const ageMin = Number.isFinite(hb) ? (now.getTime() - hb) / 60_000 : Infinity;
  if (run.host === hostname() && pidAlive(run.pid)) return { orphaned: false, heartbeat_age_min: ageMin };
  if (ageMin > orphanAfterMin()) {
    return {
      orphaned: true,
      reason: `heartbeat is ${Number.isFinite(ageMin) ? Math.floor(ageMin) : "no"} min old (threshold ${orphanAfterMin()} min)`,
      heartbeat_age_min: ageMin,
    };
  }
  if (run.host === hostname() && !pidAlive(run.pid)) {
    return { orphaned: true, reason: `pid ${typeof run.pid === "number" ? run.pid : "?"} is not alive on ${hostname()}`, heartbeat_age_min: ageMin };
  }
  return { orphaned: false, heartbeat_age_min: ageMin };
}

export interface OrphanedRun {
  run_id: string;
  agent?: string;
  turns?: number;
  spent_micro_usd?: number;
  heartbeat_age_min?: number;
  reason: string;
}

/** Every orphaned run under runsDir, for `npm run runs -- orphans`. */
export function listOrphans(runsDir: string, now = new Date()): OrphanedRun[] {
  const out: OrphanedRun[] = [];
  if (!existsSync(runsDir)) return out;
  for (const name of readdirSync(runsDir).sort()) {
    const file = path.join(runsDir, name, "run.json");
    if (!existsSync(file)) continue;
    let run: RunFileLike & Record<string, unknown>;
    try {
      run = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      out.push({ run_id: name, reason: "run.json is not valid JSON" });
      continue;
    }
    const v = orphanStatus(run, now);
    if (v.orphaned) {
      out.push({
        run_id: name,
        agent: typeof run.agent === "string" ? run.agent : undefined,
        turns: typeof run.turns === "number" ? run.turns : undefined,
        spent_micro_usd: typeof run.spent_micro_usd === "number" ? run.spent_micro_usd : undefined,
        heartbeat_age_min: v.heartbeat_age_min,
        reason: v.reason!,
      });
    }
  }
  return out;
}
