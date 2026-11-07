// The composer's model and reasoning-effort picks. One choice for the page, sent with every chat
// turn (ChatRequest.model / .effort). A null model means "the agent's own model" (its registry row).
import { useSyncExternalStore } from "react";
import type { ChatRequest } from "@fabric/contracts";

export type Effort = NonNullable<ChatRequest["effort"]>;
export const EFFORT_LABELS: Record<Effort, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };

interface Choice { model: string | null; effort: Effort }
// Off is Dana's latency default (thinking off), so an untouched picker changes nothing.
let choice: Choice = { model: null, effort: "off" };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const set = (patch: Partial<Choice>) => {
  choice = { ...choice, ...patch };
  for (const listener of listeners) listener();
};

export const setChatModel = (model: string | null) => set({ model });
export const setChatEffort = (effort: Effort) => set({ effort });
export const useModelChoice = () => useSyncExternalStore(subscribe, () => choice);
/** The request fields for the next turn. */
export const modelChoiceFields = (): Pick<ChatRequest, "model" | "effort"> => ({
  ...(choice.model ? { model: choice.model } : {}),
  effort: choice.effort,
});
