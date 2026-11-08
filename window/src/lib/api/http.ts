import {
  ContextSnapshotSchema, OccurrenceSchema, ProjectSchema, RegistrySchema, ReportSchema,
  RunEventSchema, RunSchema, ScheduleFireSchema, ScheduleSchema, SessionEventSchema, SessionMessagesSchema, TaskSchema,
  WeaveSnapshotSchema,
  type CreateSessionRequest, type CreateSessionResponse, type ContextSnapshot, type FinalizeResponse, type FollowSessionOptions, type Occurrence,
  type PostMessageInput, type PostMessageResponse,
  type Project, type Registry, type Report, type Run, type RunEvent, type Schedule, type ScheduleFire,
  type ScheduleInput, type SchedulePatch, type SessionEvent, type SessionMessages, type SpliceResponse, type Task,
  type WeaveSnapshot,
} from "@fabric/contracts";
import { createSession, followSession, postMessage } from "@fabric/contracts";
import { z } from "zod";
import { currentApiBase } from "../studio";
import { buildBoardView, type BoardCardRow, type BoardView } from "./board-view";

const dev = import.meta.env.DEV;

async function request<T>(path: string, schema: z.ZodType, init?: RequestInit, missing = false): Promise<T> {
  const response = await fetch(`${currentApiBase()}/api${path}`, init);
  if (missing && response.status === 404) return undefined as T;
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  const value: unknown = await response.json();
  if (dev) {
    const checked = schema.safeParse(value);
    if (!checked.success) console.warn(`[api] ${path} contract mismatch`, checked.error.issues);
  }
  return value as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const spliceSchema = z.object({ run: RunSchema, events: z.array(RunEventSchema) });
const finalizeSchema = z.object({ reportId: z.string() });
const okSchema = z.object({ ok: z.boolean() });
const interventionsSchema = z.object({
  eventStart: z.string(),
  count: z.number(),
  /** Category tallies the ledger assigns (steering, harness, account, approval, ...). */
  by_category: z.record(z.string(), z.number()).optional(),
  entries: z.array(z.object({ ts: z.string(), who: z.string(), action: z.string(), reason: z.string(), category: z.string().optional() })),
  /** Calls the agents made on their own, from the same ledger (absent on older adapters). */
  decisions: z.object({
    count: z.number(),
    by_agent: z.record(z.string(), z.number()),
    entries: z.array(z.object({ ts: z.string(), agent: z.string(), topic: z.string(), decision: z.string(), rationale: z.string() })),
  }).optional(),
});
export type Interventions = z.infer<typeof interventionsSchema>;
const galleryEntrySchema = z.object({
  asset: z.string(), file: z.string(), url: z.string(), provider: z.string(),
  verdict: z.enum(["accepted", "rejected"]), reason: z.string(),
  gate: z.record(z.string(), z.union([z.number(), z.boolean(), z.null()])).nullable(),
  runId: z.string(), ts: z.string(),
});
export type GalleryEntry = z.infer<typeof galleryEntrySchema>;
export interface ArtGallery { repos: string[]; entries: GalleryEntry[] }
const gallerySchema = z.object({ repos: z.array(z.string()), entries: z.array(galleryEntrySchema) });
const statusCountsSchema = z.object({ todo: z.number(), doing: z.number(), blocked: z.number(), done: z.number() });
const boardSummarySchema = z.object({ byAssignee: z.record(z.string(), statusCountsSchema), runsByAgent: z.record(z.string(), z.number()).default({}) });
export type BoardSummary = z.infer<typeof boardSummarySchema>;
const showcaseSchema = z.array(z.object({
  game: z.string(), name: z.string(), itchUrl: z.string().nullable(), cover: z.string().nullable(),
  capsules: z.array(z.string()), trailer: z.string().nullable(), storeMd: z.string().nullable(),
}));
/** One studio-made game as the showcase presents it: store art, trailer, itch page (GET /api/showcase). */
export type ShowcaseGame = z.infer<typeof showcaseSchema>[number];
const decisionSchema = z.object({ ok: z.boolean(), id: z.string(), decision: z.enum(["kept", "forgotten"]) });

const boardCardSchema = z.object({
  id: z.string(), title: z.string(), status: z.enum(["todo", "doing", "blocked", "done"]), assignee: z.string().nullable(),
  game: z.string().nullable(), created_at: z.string(), updated_at: z.string(), upstream: z.array(z.string()).optional(),
});

/**
 * The Work view (projects per game, board cards as tasks; see board-view.ts), built from the adapter's runs,
 * per-run tasks and board cards. One build serves every loader in a navigation (cached for a few seconds).
 * An adapter without /board-cards still gets projects per game, with one task per run.
 */
let view: { at: number; base: string; promise: Promise<BoardView> } | undefined;
let latestView: BoardView | undefined;
function boardView(): Promise<BoardView> {
  const base = currentApiBase();
  if (view && view.base === base && Date.now() - view.at < 5_000) return view.promise;
  const promise = Promise.all([
    request<Task[]>("/tasks", z.array(TaskSchema)),
    request<Run[]>("/runs", z.array(RunSchema)),
    request<BoardCardRow[]>("/board-cards", z.array(boardCardSchema)).catch(() => [] as BoardCardRow[]),
    request<Registry>("/registry", RegistrySchema),
  ]).then(([tasks, runs, cards, registry]) => {
    const teamOfAgent = (agent: string) => registry.teams.find((t) => t.members.some((m) => m.agentId === agent))?.id;
    return (latestView = buildBoardView({ tasks, runs, cards, teamOfAgent }));
  });
  promise.catch(() => { view = undefined; });
  view = { at: Date.now(), base, promise };
  return promise;
}
/** The board card behind a live task, from the last Work view built (undefined in mock mode or for run-only tasks). */
export const boardCardOf = (taskId: string) => latestView?.cards.get(taskId);

export const httpApi = {
  /** Human interventions in the studio ledger since the event started (chat messages, logged by the adapter). */
  getInterventions: () => request<Interventions>("/interventions", interventionsSchema),
  /** Kept art candidates and contact sheets from the studio game repo(s) (T18). */
  getGallery: () => request<ArtGallery>("/art-gallery", gallerySchema),
  /** Each game's store art, trailer and itch page; [] from an adapter without /api/showcase. */
  getShowcase: () => request<ShowcaseGame[]>("/showcase", showcaseSchema).catch(() => [] as ShowcaseGame[]),
  getRegistry: () => request<Registry>("/registry", RegistrySchema),
  getWeave: () => request<WeaveSnapshot>("/weave", WeaveSnapshotSchema),
  /** Board card counts per assignee and status (Flow tab: where the game sits in the pipeline). */
  getBoardSummary: () => request<BoardSummary>("/board-summary", boardSummarySchema),
  /** One project per game, plus Studio (board-view.ts); the adapter's single "studio" project is not used. */
  listProjects: async (): Promise<Project[]> => (await boardView()).projects,
  createProject: (input: { name: string; goal: string }) => request<Project>("/projects", ProjectSchema, json(input)),
  /** Board cards as tasks (holding their runs), plus one task per card-less run. */
  listTasks: async (): Promise<Task[]> => (await boardView()).tasks,
  listRuns: () => request<Run[]>("/runs", z.array(RunSchema)),
  /** A card task by id, or the task now holding an adapter task's run (runs and reports link by the old id). */
  getTask: async (id: string): Promise<Task | undefined> => {
    const v = await boardView();
    const held = v.taskOf.get(id) ?? id;
    return v.tasks.find((t) => t.id === held) ?? request<Task | undefined>(`/tasks/${encodeURIComponent(id)}`, TaskSchema, undefined, true);
  },
  getRun: (id: string) => request<Run | undefined>(`/runs/${encodeURIComponent(id)}`, RunSchema, undefined, true),
  getRunEvents: (id: string) => request<RunEvent[]>(`/runs/${encodeURIComponent(id)}/events`, z.array(RunEventSchema)),
  getSnapshots: (id: string) => request<ContextSnapshot[]>(`/runs/${encodeURIComponent(id)}/snapshots`, z.array(ContextSnapshotSchema)),
  getReport: (id: string) => request<Report | undefined>(`/reports/${encodeURIComponent(id)}`, ReportSchema, undefined, true),
  spliceRun: (id: string, t: number) => request<SpliceResponse>(`/runs/${encodeURIComponent(id)}/splice`, spliceSchema, json({ t })),
  finalizeSplice: (id: string) => request<FinalizeResponse>(`/runs/${encodeURIComponent(id)}/finalize-splice`, finalizeSchema, json({})),
  // Schedules (SCH): the routines and the occurrences read model.
  listSchedules: () => request<Schedule[]>("/schedules", z.array(ScheduleSchema)),
  createSchedule: (input: ScheduleInput) => request<Schedule>("/schedules", ScheduleSchema, json(input)),
  updateSchedule: (id: string, patch: SchedulePatch) =>
    request<Schedule>(`/schedules/${encodeURIComponent(id)}`, ScheduleSchema, { ...json(patch), method: "PATCH" }),
  deleteSchedule: (id: string) =>
    request<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`, okSchema, { method: "DELETE" }),
  runScheduleNow: (id: string) =>
    request<ScheduleFire>(`/schedules/${encodeURIComponent(id)}/run`, ScheduleFireSchema, json({})),
  skipOccurrence: (id: string, at: string) =>
    request<ScheduleFire>(`/schedules/${encodeURIComponent(id)}/skip`, ScheduleFireSchema, json({ at })),
  listOccurrences: (from: string, to: string) =>
    request<Occurrence[]>(`/schedules/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, z.array(OccurrenceSchema)),
  // MEM: Keep pins a memory, Forget soft-deletes it (POST /memories/:id/decision).
  decideMemory: (id: string, decision: "kept" | "forgotten") =>
    request<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}/decision`, decisionSchema, json({ decision })),
  // Chat: the thread history read; turns go through the session stream (RUNTIME §13).
  getSessionMessages: (id: string) => request<SessionMessages>(`/sessions/${encodeURIComponent(id)}/messages`, SessionMessagesSchema),
  createSession: (req: CreateSessionRequest): Promise<CreateSessionResponse> => createSession(fetch, currentApiBase(), req),
  postMessage: (id: string, req: PostMessageInput): Promise<PostMessageResponse & { done?: Promise<void> }> =>
    postMessage(fetch, currentApiBase(), id, req).then((res) => ({ ...res, done: undefined })),
  followSession: (id: string, opts: FollowSessionOptions): Promise<void> => followSession(fetch, currentApiBase(), id, opts),
  // Sessions (RUNTIME §13): post, then follow the stream. The S12a client over the global fetch.
  getSessionEvents: (id: string) => request<SessionEvent[]>(`/sessions/${encodeURIComponent(id)}/events`, z.array(SessionEventSchema)),
};
