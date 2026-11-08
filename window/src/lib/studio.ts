import { useSyncExternalStore } from "react";

// Multi-studio mode (desktop brief, goal 1): VITE_STUDIOS is a JSON array of adapters,
// e.g. '[{"id":"s1","label":"Studio 1","api":"http://127.0.0.1:8787"},
//        {"id":"s2","label":"Studio 2","api":"http://127.0.0.1:8790","readOnly":true}]'.
// Unset or unusable -> single-studio mode: one API base (VITE_API_URL, default 8787),
// no switcher, exactly the behaviour the single-studio launchers ship today.

export interface Studio {
  id: string;
  label: string;
  /** Adapter base URL, no trailing slash. */
  api: string;
  /** Mirror adapters refuse chat writes (403); the UI shows them as read-only up front. */
  readOnly?: boolean;
}

/** The base used when no studios are configured: the historical single-adapter default. */
export const singleApiBase = (import.meta.env.VITE_API_URL || "http://localhost:8787").replace(/\/$/, "");

/** Parse the VITE_STUDIOS config. Tolerant: a bad config never breaks the single-studio app. */
export function parseStudios(json: string | undefined): Studio[] {
  if (!json?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn("[studio] VITE_STUDIOS is not valid JSON; running single-studio", err);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[studio] VITE_STUDIOS must be a JSON array; running single-studio");
    return [];
  }
  const out: Studio[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label, api, readOnly } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof label !== "string" || !label ||
        typeof api !== "string" || !/^https?:\/\/.+/.test(api)) {
      console.warn("[studio] skipping VITE_STUDIOS entry (needs id, label, http api)", entry);
      continue;
    }
    if (out.some((s) => s.id === id)) continue; // duplicate ids would make the saved pick ambiguous
    out.push(readOnly === true ? { id, label, api: api.replace(/\/$/, ""), readOnly: true } : { id, label, api: api.replace(/\/$/, "") });
  }
  return out;
}

const STORAGE_KEY = "anyco.studio.id";
const configured = parseStudios(import.meta.env.VITE_STUDIOS);

/** Best effort (private windows refuse localStorage): the viewer's last studio, if still configured. */
const remembered = (list: Studio[]): string | undefined => {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return list.some((s) => s.id === id) ? (id as string) : undefined;
  } catch {
    return undefined;
  }
};


let studios = configured;
let selectedId = remembered(configured) ?? configured[0]?.id;

export interface StudioState {
  /** All configured studios; empty in single-studio mode. */
  studios: Studio[];
  /** The selected studio, or undefined in single-studio mode. */
  studio?: Studio;
}

let state: StudioState = { studios, studio: studios.find((s) => s.id === selectedId) };
const listeners = new Set<() => void>();
const publish = () => {
  state = { studios, studio: studios.find((s) => s.id === selectedId) };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStudio(): StudioState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Switch studio. The app remounts against the new base (main.tsx keys the router on it). */
export function switchStudio(id: string) {
  if (id === selectedId || !studios.some((s) => s.id === id)) return;
  selectedId = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private window: the pick just doesn't stick */ }
  publish();
}

/** The API base every fetch and SSE stream must use right now. */
export function currentApiBase(): string {
  return state.studio?.api ?? singleApiBase;
}

/** Storybook seam: mount the switcher against a pretend config. Production never calls this. */
export function setStudiosForStory(next: Studio[]) {
  studios = next;
  selectedId = remembered(next) ?? next[0]?.id;
  publish();
}

/** Storybook seam: restore the real config after a story. */
export function resetStudioStore() {
  setStudiosForStory(configured);
}
