// Offline seam. The 135M log, snapshots and report use the same current bundle as the server.
import { recordings } from "@fabric/fixtures/recordings";
import { myProfiles, communityProfiles } from "@fabric/fixtures/studio";
import { studioTeams, communityTeams, organizations } from "@fabric/fixtures/teams";
import { sessions } from "@fabric/fixtures/sessions";
import { inboxSeed, pulseSeed, presenceSeed, calendarEvents } from "@fabric/fixtures/weave";
import { projects, type Project } from "../mock/sessions";
import { allSnapshots, runEventsById, runs, tasks } from "../mock/work";
import {
  mockCreateSchedule, mockDeleteSchedule, mockOccurrences, mockRunNow, mockSchedules,
  mockScheduleSessions, mockSkipOccurrence, mockUpdateSchedule,
} from "../mock/schedule";
import type { Occurrence, Schedule, ScheduleFire, ScheduleInput, SchedulePatch } from "@fabric/contracts";
import type { Registry, WeaveSnapshot } from "@fabric/contracts";
import type {
  CreateSessionRequest, CreateSessionResponse, FollowSessionOptions, PostMessageInput, PostMessageResponse,
  SessionDelta, SessionEvent,
} from "@fabric/contracts";
import { projectThread } from "@fabric/contracts";
import { resetSessionStreams } from "@/lib/chat/session-stream";
import { mockAssistant } from "../mock/chat";
import type { ContextSnapshot, Report, Run, RunEvent, Task } from "../types";

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const bundle = recordings["ngram-135m"];
const recordingId = bundle.run.idHint;
const recordingEvents: RunEvent[] = bundle.events.map(({ seqHint, ...event }) => ({ ...event, seq: seqHint, runId: recordingId }));
const recordingSnapshots: ContextSnapshot[] = bundle.snapshots.map(({ idHint, ...snapshot }) => ({ ...snapshot, id: idHint, runId: recordingId }));
const recordingReport: Report = { ...bundle.report, id: bundle.report.idHint, runId: recordingId };
const bundledRuns = runs.map((r) => r.id === recordingId ? {
  ...r, ...bundle.run, id: recordingId, taskId: r.taskId, teamId: r.teamId, n: r.n,
  recorded: r.recorded, segments: r.segments, brief: bundle.run.brief, reportId: recordingReport.id,
} : r);

// Test seam: createProject pushes into the shared fixture-backed `projects` array; the
// storybook harness restores this snapshot so stories never accumulate mock state.
const projectSeed = [...projects];

// The routines' threads are part of the seeded world (SCH), so the sidebar matches the server.
const registry: Registry = { agents: myProfiles, communityAgents: communityProfiles, teams: studioTeams, communityTeams, organizations, projects, sessions: [...sessions, ...mockScheduleSessions], personaPool: [] };
const weaveSnapshot: WeaveSnapshot = { items: inboxSeed, pulse: pulseSeed, presence: presenceSeed, calendar: calendarEvents };

// ---- The in-memory session log (RUNTIME §13) --------------------------------

interface MockSession {
  id: string;
  events: SessionEvent[];
  /** Live-stream subscribers, as the follow loop registers them. */
  eventListeners: Set<(event: SessionEvent) => void>;
  deltaListeners: Set<(delta: SessionDelta) => void>;
  /** The newest cumulative text while a turn streams; the mid-call join re-sends it. */
  pendingDelta?: SessionDelta;
  turn: number;
}

const mockSessions = new Map<string, MockSession>();
let mockSessionSeq = 0;

function mockSession(id: string): MockSession {
  const existing = mockSessions.get(id);
  if (existing) return existing;
  const session: MockSession = { id, events: [], eventListeners: new Set(), deltaListeners: new Set(), turn: 0 };
  mockSessions.set(id, session);
  return session;
}

function mockEvent(type: string, payload: unknown): SessionEvent {
  return { seq: 0, type, class: "fact", payload, ts: new Date().toISOString() };
}

/** Append to the mock log: seq from position, live listeners notified per event. */
function mockAppend(session: MockSession, type: string, payload: unknown): SessionEvent {
  const event = mockEvent(type, payload);
  event.seq = session.events.length + 1;
  session.events.push(event);
  for (const listener of Array.from(session.eventListeners)) listener(event);
  return event;
}
export const mockApi = {
  getRegistry: (): Promise<Registry> => delay(registry),
  getWeave: (): Promise<WeaveSnapshot> => delay(weaveSnapshot),
  listProjects: (): Promise<Project[]> => delay(projects),
  createProject: ({ name, goal }: { name: string; goal: string }): Promise<Project> => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const id = projects.some((p) => p.id === base) ? `${base}-${projects.length + 1}` : base;
    const project = { id, name, goal };
    projects.push(project);
    return delay(project);
  },
  /** Every task (board card), with its loops' ids. */
  listTasks: (): Promise<Task[]> => delay(tasks),
  /** Every loop of every task. */
  listRuns: (): Promise<Run[]> => delay(bundledRuns),
  getTask: (id: string): Promise<Task | undefined> => delay(tasks.find((t) => t.id === id)),
  getRun: (id: string): Promise<Run | undefined> => delay(bundledRuns.find((r) => r.id === id)),
  /** Full ordered event log for a loop. Live mode would tail this over SSE. */
  getRunEvents: (id: string): Promise<RunEvent[]> => delay(id === recordingId ? recordingEvents : runEventsById[id] ?? []),
  getSnapshots: (runId: string): Promise<ContextSnapshot[]> =>
    delay(runId === recordingId ? recordingSnapshots : allSnapshots.filter((s) => s.runId === runId)),
  getReport: (id: string): Promise<Report | undefined> => delay(id === recordingReport.id ? recordingReport : undefined),
  // Schedules (SCH): the in-memory store in lib/mock/schedule, seeded from the fixtures.
  listSchedules: (): Promise<Schedule[]> => delay(mockSchedules()),
  createSchedule: (input: ScheduleInput): Promise<Schedule> => delay(mockCreateSchedule(input)),
  updateSchedule: (id: string, patch: SchedulePatch): Promise<Schedule> => {
    const next = mockUpdateSchedule(id, patch);
    if (!next) return Promise.reject(new Error("schedule not found"));
    return delay(next);
  },
  deleteSchedule: (id: string): Promise<{ ok: boolean }> => delay({ ok: mockDeleteSchedule(id) }),
  runScheduleNow: (id: string): Promise<ScheduleFire> => {
    const fire = mockRunNow(id);
    return fire ? delay(fire) : Promise.reject(new Error("schedule not found"));
  },
  skipOccurrence: (id: string, at: string): Promise<ScheduleFire> => {
    const fire = mockSkipOccurrence(id, at);
    return fire ? delay(fire) : Promise.reject(new Error("that occurrence is already claimed"));
  },
  listOccurrences: (from: string, to: string): Promise<Occurrence[]> =>
    delay(mockOccurrences(new Date(from), new Date(to), bundledRuns)),
  /** No-op offline: mock memory decisions stay client-side (the mock pulse rows have no memoryId). */
  decideMemory: (): Promise<{ ok: true }> => delay({ ok: true }),
  // Sessions (RUNTIME §13): the log, in memory. The agent's turn is the scripted
  // adapter's (mockAssistant, the same brain the pre-session mock streamed) — its
  // progressive yields relay as cumulative deltas, its last yield becomes the
  // logged tool calls plus the final `agent.message`, exactly the shape the
 // projection renders. The swap-seams on `mockAssistant.run` keep working.
  createSession: ({ agentId, incognito }: CreateSessionRequest): Promise<CreateSessionResponse> => {
    const session = mockSession(`${agentId || "dana"}-${++mockSessionSeq}`);
    mockAppend(session, "session.created", { agentId, incognito: incognito ?? false, surfaces: ["app"] });
    return delay({ sessionId: session.id });
  },
  postMessage: (id: string, req: PostMessageInput): Promise<PostMessageResponse & { done?: Promise<void> }> => {
    const session = mockSessions.get(id);
    if (!session) return Promise.reject(new Error("session not found"));
    const event = mockAppend(session, "message.received", {
      text: req.text,
      attachments: req.attachments ?? [],
      surface: "app",
      sender: "user",
      platformMessageId: req.clientMessageId,
    });
    const done = mockTurn(session, req.attachments);
    // A failing turn rejects before the adapter can attach its own handlers
    // (the failure lands while the post's delay is still pending, so the
    // global unhandled-rejection tracker would fire first). Marking it handled
    // here keeps that tracker quiet; later consumers still see the rejection.
    done.catch(() => {});
    return delay({ seq: event.seq, done });
  },
  followSession: (id: string, { after, onEvent, onDelta, signal }: FollowSessionOptions): Promise<void> => {
    const session = mockSessions.get(id);
    if (!session) return Promise.resolve();
    for (const event of session.events) if (event.seq > (after ?? 0)) onEvent(event);
    // Mid-call join, S6 parity: the newest known text, at once.
    if (session.pendingDelta) onDelta(session.pendingDelta);
    const onEventEntry = (event: SessionEvent): void => onEvent(event);
    const onDeltaEntry = (delta: SessionDelta): void => onDelta(delta);
    session.eventListeners.add(onEventEntry);
    session.deltaListeners.add(onDeltaEntry);
    return new Promise((resolve) => {
      const settle = (): void => {
        session.eventListeners.delete(onEventEntry);
        session.deltaListeners.delete(onDeltaEntry);
        signal?.removeEventListener("abort", settle);
        resolve();
      };
      signal?.addEventListener("abort", settle, { once: true });
    });
  },
  getSessionEvents: (id: string): Promise<SessionEvent[]> => delay([...(mockSessions.get(id)?.events ?? [])]),
};

/** The scripted brain, relayed through the log: deltas stream, the final yield
 * lands as tool calls plus `agent.message`; a failure surfaces on `done`. */
function mockTurn(session: MockSession, stamp?: unknown[]): Promise<void> {
  const turn = ++session.turn;
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        // A human-tool continuation carries the stamped assistant message; the
        // brain branches on the last message, so the stamp replaces the view.
        const stamped = stamp?.length ? (stamp[0] as { role: string; content: unknown[] }) : undefined;
        const messages = stamped ? [stamped] : projectThread(session.events);
        const last = mockAssistant.run({ messages } as never) as AsyncGenerator<{ content: unknown[] }>;
        let final: { content: unknown[] } | undefined;
        for await (const yield_ of last) {
          final = yield_;
          const text = yieldText(yield_.content);
          if (text === undefined) continue;
          const delta: SessionDelta = { turn, callNo: 1, text };
          session.pendingDelta = delta;
          for (const listener of Array.from(session.deltaListeners)) listener(delta);
        }
        const content = (final?.content ?? []) as { type: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown }[];
        for (const part of content) {
          if (part.type !== "tool-call" || !part.toolCallId) continue;
          mockAppend(session, "tool.call", { tool: part.toolName, callId: part.toolCallId, args: part.args });
        }
        const text = yieldText(content) ?? "";
        session.pendingDelta = undefined;
        mockAppend(session, "agent.message", { text });
        for (const part of content) {
          if (part.type !== "tool-call" || !part.toolCallId) continue;
          mockAppend(session, "tool.completed", { callId: part.toolCallId, ...(part.result !== undefined ? { result: part.result } : {}) });
        }
        resolve();
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

const yieldText = (content: unknown[]): string | undefined => {
  const texts = content.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text");
  return texts.length > 0 ? texts.map((part) => part.text).join("") : undefined;
};

/**
 * Test seam (storybook harness only): restore mock state that call flows mutate. In-place,
 * so every holder of the shared `projects` array sees the reset.
 */
export function resetMockData() {
  projects.length = 0;
  projects.push(...projectSeed);
  resetSessionStreams();
}
