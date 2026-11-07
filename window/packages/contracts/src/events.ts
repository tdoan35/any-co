// Run event payloads and the app invalidation stream.
// Writers validate with these schemas; the web keeps reading `RunEvent.payload` loosely.
import { z } from "zod";
import type { RunEvent, RunEventType } from "./domain";

export const SegmentKindSchema = z.enum(["work", "rework", "bounce", "wait", "blocked"]);

const step = z.object({ label: z.string(), stage: z.string(), kind: SegmentKindSchema });

export const RunEventPayloadSchemas = {
  "run.started": z.object({ objective: z.string() }),
  "step.started": step,
  "step.finished": step,
  /** Narration: what an agent says it's doing. */
  "agent.message": z.object({ text: z.string() }),
  "tool.call": z.object({ tool: z.string(), summary: z.string() }),
  /** Sandbox terminal output, line-buffered. */
  "tool.result": z.object({ line: z.string(), kind: z.literal("term") }),
  "tool.denied": z.object({ tool: z.string(), target: z.string(), reason: z.string() }),
  /** Emitted before the model call that uses the snapshot. */
  "context.snapshot": z.object({ snapshotId: z.string() }),
  handoff: z.object({ to: z.string(), step: z.string().optional() }),
  "review.verdict": z.object({ verdict: z.enum(["accept", "request_changes"]), text: z.string() }),
  "rework.requested": z.object({ to: z.string(), used: z.number().int(), budget: z.number().int() }),
  /** `index` is into `run.brief.criteria`. */
  "criterion.checked": z.object({ index: z.number().int(), pass: z.boolean(), note: z.string() }),
  "budget.update": z.object({
    reworkUsed: z.number().int().optional(),
    reworkBudget: z.number().int().optional(),
    costUsd: z.number().optional(),
  }),
  "artifact.created": z.object({ name: z.string(), artifactId: z.string().optional() }),
  /** `itemId` is the Weave item that asks you to decide. */
  "run.blocked": z.object({ reason: z.string(), itemId: z.string().optional() }),
  "run.stopped": z.object({ by: z.string(), text: z.string() }),
  "run.finished": z.object({ reportId: z.string().optional() }),
} satisfies Record<RunEventType, z.ZodType>;

export type RunEventPayloads = { [K in RunEventType]: z.infer<(typeof RunEventPayloadSchemas)[K]> };

/** A run event with its payload typed by `type`. */
export type TypedRunEvent<T extends RunEventType = RunEventType> = Omit<RunEvent, "type" | "payload"> & {
  type: T;
  payload: RunEventPayloads[T];
};

export function parseRunEventPayload<T extends RunEventType>(type: T, payload: unknown): RunEventPayloads[T] {
  return RunEventPayloadSchemas[type].parse(payload) as RunEventPayloads[T];
}

/** GET /api/stream. Invalidation only: clients refetch what changed. */
export const AppEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registry.changed") }),
  z.object({ type: z.literal("task.changed"), taskId: z.string() }),
  z.object({ type: z.literal("run.changed"), runId: z.string() }),
  z.object({ type: z.literal("weave.changed") }),
  z.object({ type: z.literal("schedule.changed") }),
  z.object({ type: z.literal("session.message"), sessionId: z.string(), messageId: z.string() }),
  z.object({
    type: z.literal("session.desktop"),
    sessionId: z.string(),
    url: z.string().nullable(),
    runId: z.string().nullable(),
    screenshotArtifactId: z.string().nullable().optional(),
    replay: z.boolean().optional(),
  }),
]);
export type AppEvent = z.infer<typeof AppEventSchema>;
