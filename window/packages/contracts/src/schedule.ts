// Schedule contracts: a routine, its fires, and the occurrence read
// model the calendar draws. Integrator change, additive under contracts-v1; helpers stay pure —
// cron expansion (croner) lives with the server and the web mock, not here.
import { z } from "zod";

/** How often a routine runs, as the picker sets it. */
export type RecurrenceFreq = "once" | "daily" | "weekdays" | "weekly" | "monthly";

/**
 * The picker's value. `time` is wall clock in the schedule's tz. `days` (0 = Sun) is weekly's
 * chosen days; `date` is once's date and monthly's day-of-month source.
 */
export interface Recurrence {
  freq: RecurrenceFreq;
  time: string;
  days?: number[];
  date?: string;
}

/** One routine. */
export interface Schedule {
  id: string;
  title: string;
  /** team = a real team run on the Work board; assistant = one Dana turn in the routine's thread. */
  kind: "team" | "assistant";
  /** The face shown on the calendar: Dana for assistant jobs, the team's lead for team jobs. */
  agentId: string;
  teamId?: string;
  projectId?: string;
  /** The objective (team) or instructions (Dana). */
  prompt: string;
  recurrence: Recurrence;
  /** Derived from `recurrence` by toCron; minute and hour are in `tz` wall clock. */
  cron: string;
  /** IANA zone the cron's wall clock runs in. */
  tz: string;
  /** Block height on the calendar only; runs take as long as they take. */
  durationMin: number;
  /** Paused: expands to nothing, keeps its history. */
  enabled: boolean;
  /** The routine's own chat thread (Dana posts results there). */
  sessionId: string;
  createdAt: string;
}

/** What happened at one slot. Claiming (schedule_id, scheduled_for) is unique, so a fire is the
 *  single durable fact for an occurrence: two processes racing both see one winner. */
export type ScheduleFireStatus = "fired" | "skipped" | "missed" | "failed";
export interface ScheduleFire {
  id: string;
  scheduleId: string;
  /** The slot this fire claims, as planned (not when it actually ran). */
  scheduledFor: string;
  firedAt?: string;
  status: ScheduleFireStatus;
  runId?: string;
  taskId?: string;
  messageId?: string;
  error?: string;
}

/** The calendar's read model: one block. Expanded from cron, with fires overlaid. */
export type OccurrenceState =
  | "upcoming" | "running" | "accepted" | "blocked" | "stopped"
  | "posted" | "skipped" | "missed" | "failed";
export interface Occurrence {
  scheduleId: string;
  at: string;
  end: string;
  agentId: string;
  title: string;
  kind: "team" | "assistant";
  state: OccurrenceState;
  runId?: string;
  taskId?: string;
  reportId?: string;
  sessionId?: string;
  messageId?: string;
}

/** POST /api/schedules. The server derives `agentId` (Dana or the team's lead), `cron` and the
 *  thread; PATCH takes the same fields, all optional. */
export interface ScheduleInput {
  title: string;
  kind: "team" | "assistant";
  teamId?: string;
  projectId?: string;
  prompt: string;
  recurrence: Recurrence;
  tz?: string;
  durationMin?: number;
}

/** PATCH /api/schedules/:id: any subset of the input, plus the enabled toggle. */
export type SchedulePatch = Partial<ScheduleInput> & { enabled?: boolean };

// ---- pure helpers ----

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "08:05" → "8:05 AM". */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The cron behind a recurrence: weekdays at 08:00 → `0 8 * * 1-5`. Fields are in `tz` wall clock. */
export function toCron(r: Recurrence): string {
  const [h, m] = r.time.split(":").map(Number);
  const head = `${m} ${h}`;
  switch (r.freq) {
    case "daily":
      return `${head} * * *`;
    case "weekdays":
      return `${head} * * 1-5`;
    case "weekly": {
      const days = [...new Set(r.days ?? [])].sort((a, b) => a - b);
      return `${head} * * ${days.length ? days.join(",") : "*"}`;
    }
    case "monthly": {
      const day = Number(r.date?.slice(8) ?? 1);
      return `${head} ${day} * *`;
    }
    case "once": {
      const [, mo, d] = (r.date ?? `${new Date().getFullYear()}-01-01`).split("-").map(Number);
      return `${head} ${d} ${mo} *`; // a year isn't a cron field: a once job pauses after it fires
    }
  }
}

const ordinal = (n: number) => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** "Weekdays at 8:00 AM" — the one-line summary the rail and the editor footer show. */
export function describeRecurrence(r: Recurrence): string {
  switch (r.freq) {
    case "daily":
      return `Daily at ${formatTime(r.time)}`;
    case "weekdays":
      return `Weekdays at ${formatTime(r.time)}`;
    case "weekly": {
      const days = [...new Set(r.days ?? [])].sort((a, b) => a - b);
      return `${days.length === 7 ? "Daily" : days.length === 1 ? `Weekly on ${DAY_SHORT[days[0]]}` : `Weekly on ${days.map((d) => DAY_SHORT[d]).join(", ")}`} at ${formatTime(r.time)}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(Number(r.date?.slice(8) ?? 1))} at ${formatTime(r.time)}`;
    case "once": {
      const [mo, d] = (r.date ?? "01-01").slice(5).split("-").map(Number);
      return `Once on ${MONTH_SHORT[mo - 1]} ${d} at ${formatTime(r.time)}`;
    }
  }
}

// ---- zod ----

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const RecurrenceSchema = z.object({
  freq: z.enum(["once", "daily", "weekdays", "weekly", "monthly"]),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  days: z.array(z.number().int().min(0).max(6)).optional(),
  date: z.string().regex(DAY_KEY).optional(),
}) satisfies z.ZodType<Recurrence>;

export const ScheduleSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["team", "assistant"]),
  agentId: z.string(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  prompt: z.string(),
  recurrence: RecurrenceSchema,
  cron: z.string(),
  tz: z.string(),
  durationMin: z.number().int().min(5).max(480),
  enabled: z.boolean(),
  sessionId: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodType<Schedule>;

export const ScheduleInputSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(["team", "assistant"]),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  prompt: z.string().min(1),
  recurrence: RecurrenceSchema,
  tz: z.string().optional(),
  durationMin: z.number().int().min(5).max(480).optional(),
}) satisfies z.ZodType<ScheduleInput>;

/** PATCH /api/schedules/:id — every input field, plus the enabled toggle. */
export const SchedulePatchSchema = ScheduleInputSchema.partial().extend({ enabled: z.boolean().optional() }) satisfies z.ZodType<SchedulePatch>;

export const ScheduleFireSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  scheduledFor: z.string(),
  firedAt: z.string().optional(),
  status: z.enum(["fired", "skipped", "missed", "failed"]),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  messageId: z.string().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ScheduleFire>;

export const OccurrenceSchema = z.object({
  scheduleId: z.string(),
  at: z.string(),
  end: z.string(),
  agentId: z.string(),
  title: z.string(),
  kind: z.enum(["team", "assistant"]),
  state: z.enum(["upcoming", "running", "accepted", "blocked", "stopped", "posted", "skipped", "missed", "failed"]),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  reportId: z.string().optional(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
}) satisfies z.ZodType<Occurrence>;
