// The mock schedule world (SCH): an in-memory store seeded from the fixtures, with the same cron
// expansion + fires overlay the server runs (services/schedule-cron.ts), so the calendar works
// with the server off. "Run now" appends a fire — posted for Dana, running for a team.
import { Cron } from "croner";
import { toCron } from "@fabric/contracts";
import type { Occurrence, Run, Schedule, ScheduleFire, ScheduleInput, SchedulePatch, Session } from "@fabric/contracts";
import { scheduleFires, scheduleSessions, schedules as seedSchedules } from "@fabric/fixtures/schedules";
import { studioTeams } from "@fabric/fixtures/teams";

/** The routines' threads, appended to the mock registry so the sidebar matches the seeded server. */
export const mockScheduleSessions: Session[] = scheduleSessions;

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "routine";

const leadOf = (teamId: string): string =>
  studioTeams.find((t) => t.id === teamId)?.members.find((m) => m.lead)?.agentId ?? "dana";

const schedules: Schedule[] = [...seedSchedules];
const fires: ScheduleFire[] = [...scheduleFires];

function slots(cron: string, tz: string, from: Date, to: Date): Date[] {
  const pattern = new Cron(cron, { timezone: tz });
  const out: Date[] = [];
  let cursor: Date | null = from;
  for (let i = 0; i < 1000 && cursor !== null; i++) {
    const next = pattern.nextRun(cursor);
    if (!next || next >= to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** The same overlay the server returns: fires win, off-pattern fires show, past-unfired doesn't. */
export function mockOccurrences(from: Date, to: Date, runs: Run[], now = new Date()): Occurrence[] {
  const out: Occurrence[] = [];
  for (const s of schedules) {
    // Paused expands to nothing planned, but keeps its history: fires still show.
    const planned = (s.enabled ? slots(s.cron, s.tz, from, to) : []).map((d) => d.getTime());
    const plannedSet = new Set(planned);
    const extra = fires
      .filter((f) => f.scheduleId === s.id)
      .map((f) => new Date(f.scheduledFor).getTime())
      .filter((t) => t >= from.getTime() && t < to.getTime() && !plannedSet.has(t));
    for (const t of [...planned, ...extra].sort((a, b) => a - b)) {
      const fire = fires.find((f) => f.scheduleId === s.id && new Date(f.scheduledFor).getTime() === t);
      if (!fire && t <= now.getTime()) continue;
      const run = fire?.runId ? runs.find((r) => r.id === fire.runId) : undefined;
      const state: Occurrence["state"] = !fire ? "upcoming"
        : fire.status === "skipped" ? "skipped"
        : fire.status === "missed" ? "missed"
        : fire.status === "failed" ? "failed"
        : s.kind === "team" ? (run?.status ?? "running")
        : fire.messageId ? "posted" : "running";
      out.push({
        scheduleId: s.id,
        at: new Date(t).toISOString(),
        end: new Date(t + s.durationMin * 60_000).toISOString(),
        agentId: s.agentId,
        title: s.title,
        kind: s.kind,
        state,
        runId: fire?.runId,
        taskId: fire?.taskId,
        reportId: run?.reportId,
        sessionId: s.sessionId,
        messageId: fire?.messageId,
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export const mockSchedules = () => schedules;

export function mockCreateSchedule(input: ScheduleInput): Schedule {
  const base = slug(input.title);
  const id = schedules.some((s) => s.id === base) ? `${base}-${schedules.length + 1}` : base;
  const schedule: Schedule = {
    id,
    title: input.title,
    kind: input.kind,
    agentId: input.kind === "team" && input.teamId ? leadOf(input.teamId) : "dana",
    teamId: input.teamId,
    projectId: input.projectId,
    prompt: input.prompt,
    recurrence: input.recurrence,
    cron: toCron(input.recurrence),
    tz: input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    durationMin: input.durationMin ?? 30,
    enabled: true,
    sessionId: `sched-${id}`,
    createdAt: new Date().toISOString(),
  };
  schedules.push(schedule);
  return schedule;
}

export function mockUpdateSchedule(id: string, patch: SchedulePatch): Schedule | undefined {
  const s = schedules.find((x) => x.id === id);
  if (!s) return undefined;
  Object.assign(s, patch);
  if (patch.recurrence) {
    s.cron = toCron(patch.recurrence);
  }
  if (patch.teamId && s.kind === "team") s.agentId = leadOf(patch.teamId);
  return { ...s };
}

export function mockDeleteSchedule(id: string): boolean {
  const i = schedules.findIndex((x) => x.id === id);
  if (i === -1) return false;
  schedules.splice(i, 1);
  for (let j = fires.length - 1; j >= 0; j--) if (fires[j].scheduleId === id) fires.splice(j, 1);
  return true;
}

let fireSeq = 1;

/** Run now (mock): a fire at this instant — posted for Dana, running for a team. */
export function mockRunNow(id: string): ScheduleFire | undefined {
  const s = schedules.find((x) => x.id === id);
  if (!s) return undefined;
  const fire: ScheduleFire = {
    id: `fire-${id}-now-${fireSeq++}`,
    scheduleId: id,
    scheduledFor: new Date().toISOString(),
    firedAt: new Date().toISOString(),
    status: "fired",
    ...(s.kind === "assistant" ? { messageId: `msg-now-${fireSeq}` } : { runId: `run-${id}-now-${fireSeq}`, taskId: `${id}-now` }),
  };
  fires.push(fire);
  return fire;
}

/** Skip one occurrence: pre-claims the slot, so the block stays struck through. */
export function mockSkipOccurrence(id: string, at: string): ScheduleFire | undefined {
  const s = schedules.find((x) => x.id === id);
  if (!s) return undefined;
  const t = new Date(at).getTime();
  if (fires.some((f) => f.scheduleId === id && new Date(f.scheduledFor).getTime() === t)) return undefined;
  const fire: ScheduleFire = {
    id: `fire-${id}-skip-${fireSeq++}`,
    scheduleId: id,
    scheduledFor: at,
    firedAt: new Date().toISOString(),
    status: "skipped",
  };
  fires.push(fire);
  return fire;
}
