// Recording bundles: a recorded loop as one importable JSON file.
// `kind: "illustrative"` bundles come from the mock world (D9); `real` ones from scripts/export-recording.ts.
// Ids are hints: import re-stamps run/report ids (using the hints when free) and always re-stamps
// event runId/seq, so the same bundle can be imported on any branch.
import type { Brief, ContextSnapshot, RecordingKind, Report, Run, RunEvent } from "@fabric/contracts";
import ngram135m from "./ngram-135m.json";

export interface RecordingBundle {
  key: string;
  kind: RecordingKind;
  exportedAt: string;
  /** What the demo splices into; produced by the real team on the real task. */
  run: {
    idHint: string;
    objective: string;
    /** The loop's final status in the recording. */
    status: Run["status"];
    startedAt: string;
    durationS: number;
    costUsd: number;
    budget: Run["budget"];
    reworkBudget: number;
    assistantTokens: number;
    brief: Brief;
    outcome?: string;
  };
  /** In playback order; `t` is seconds from `run.startedAt`. `seqHint` preserves the source seqs
   *  (the mock's are creation-ordered, so the imported log equals the fixture log exactly). */
  events: (Omit<RunEvent, "runId" | "seq"> & { seqHint: number })[];
  /** `idHint` preserves the source snapshot ids when the import target is free. */
  snapshots: (Omit<ContextSnapshot, "id" | "runId"> & { idHint: string })[];
  artifacts: { name: string; by: string; contentType: string; content: string }[];
  report: Omit<Report, "id" | "runId"> & { idHint: string };
}

/** Static registry of bundles; look up with `recordings[key]` (keys: DEMO_RECORDING_KEY, …). */
export const recordings: Record<string, RecordingBundle> = { [ngram135m.key]: ngram135m as RecordingBundle };
