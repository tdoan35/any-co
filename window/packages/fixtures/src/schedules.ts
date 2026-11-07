// Schedule fixtures (SCH): the seeded week around WEAVE_NOW (Fri Oct 2, 11:20 AM), the same mock
// clock as Weave and Work. Assistant fires carry their message; team fires point at the seeded
// loops, so the calendar's past shows accepted (with its report link) and blocked, and skip shows
// struck through. Fires land inside their week; future slots expand from cron.
import type { Schedule, ScheduleFire, Session } from "@fabric/contracts";
import { run as run135 } from "./run";

export const scheduleSessions: Session[] = [
  { id: "sched-morning-digest", title: "Morning digest", href: "/", agentId: "dana", messages: 5, updated: "2h" },
  { id: "sched-weekly-literature-sweep", title: "Weekly literature sweep", href: "/", agentId: "elliot", teamId: "research", messages: 3, updated: "3d" },
  { id: "sched-demand-pulse", title: "Demand pulse", href: "/", agentId: "diego", teamId: "product", messages: 2, updated: "1w" },
];

export const schedules: Schedule[] = [
  {
    id: "morning-digest",
    title: "Morning digest",
    kind: "assistant",
    agentId: "dana",
    prompt: "Check messages, runs and overnight results; give me the three things that changed and what needs my call today.",
    recurrence: { freq: "daily", time: "08:00" },
    cron: "0 8 * * *",
    tz: "America/Los_Angeles",
    durationMin: 30,
    enabled: true,
    sessionId: "sched-morning-digest",
    createdAt: "2026-09-25T09:00:00-07:00",
  },
  {
    id: "weekly-literature-sweep",
    title: "Weekly literature sweep",
    kind: "team",
    agentId: "elliot",
    teamId: "research",
    projectId: "engram",
    prompt: "Sweep this week's literature on n-gram tables and small-model memory; flag anything that changes the 360M experiment.",
    recurrence: { freq: "weekly", time: "09:00", days: [1] },
    cron: "0 9 * * 1",
    tz: "America/Los_Angeles",
    durationMin: 60,
    enabled: true,
    sessionId: "sched-weekly-literature-sweep",
    createdAt: "2026-09-20T09:00:00-07:00",
  },
  {
    id: "demand-pulse",
    title: "Demand pulse",
    kind: "team",
    agentId: "diego",
    teamId: "product",
    projectId: "product",
    prompt: "Take the week's findings and check demand signals for the lookup-table idea: who is asking for this, and where?",
    recurrence: { freq: "weekly", time: "14:00", days: [5] },
    cron: "0 14 * * 5",
    tz: "America/Los_Angeles",
    durationMin: 45,
    enabled: true,
    sessionId: "sched-demand-pulse",
    createdAt: "2026-09-26T10:00:00-07:00",
  },
];

/** Mon Sep 21's sweep ran out of rework budget: `run-nand-2` is the seeded blocked loop. */
export const scheduleFires: ScheduleFire[] = [
  { id: "fire-morning-digest-20260928", scheduleId: "morning-digest", scheduledFor: "2026-09-28T08:00:00-07:00", firedAt: "2026-09-28T08:00:03-07:00", status: "fired", messageId: "msg-401" },
  { id: "fire-morning-digest-20260929", scheduleId: "morning-digest", scheduledFor: "2026-09-29T08:00:00-07:00", firedAt: "2026-09-29T08:00:02-07:00", status: "skipped" },
  { id: "fire-morning-digest-20260930", scheduleId: "morning-digest", scheduledFor: "2026-09-30T08:00:00-07:00", firedAt: "2026-09-30T08:00:04-07:00", status: "fired", messageId: "msg-402" },
  { id: "fire-morning-digest-20261001", scheduleId: "morning-digest", scheduledFor: "2026-10-01T08:00:00-07:00", firedAt: "2026-10-01T08:00:02-07:00", status: "fired", messageId: "msg-403" },
  { id: "fire-morning-digest-20261002", scheduleId: "morning-digest", scheduledFor: "2026-10-02T08:00:00-07:00", firedAt: "2026-10-02T08:00:03-07:00", status: "fired", messageId: "msg-404" },
  { id: "fire-weekly-literature-sweep-20260921", scheduleId: "weekly-literature-sweep", scheduledFor: "2026-09-21T09:00:00-07:00", firedAt: "2026-09-21T09:00:05-07:00", status: "fired", runId: "run-nand-2", taskId: "nand-probe" },
  { id: "fire-weekly-literature-sweep-20260928", scheduleId: "weekly-literature-sweep", scheduledFor: "2026-09-28T09:00:00-07:00", firedAt: "2026-09-28T09:00:04-07:00", status: "fired", runId: run135.id, taskId: "ngram-135m" },
];
