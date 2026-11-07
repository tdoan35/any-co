import { useSyncExternalStore } from "react";
import { WEAVE_NOW, inboxSeed as fixtureItems, presenceSeed, pulseSeed, calendarEvents as fixtureCalendar, dayMarkers as fixtureMarkers, type InboxItem, type ItemKind, type Presence, type PulseEntry, type UpdateEntry } from "./mock/weave";
import type { CalendarEvent, WeaveSnapshot } from "@fabric/contracts";
import { api, httpMode } from "./api";

/**
 * Weave's state lives in a module-level store rather than in the page, so the sidebar's
 * "needs you" count stays in sync and decisions survive navigating to a run and back.
 * Mock only: a backend would push these as events.
 */
export type ItemStatus = "open" | "snoozed" | "done";
export interface ItemState {
  status: ItemStatus;
  unread: boolean;
  outcome?: string;
  /** The action that resolved it, so other pages (Work) can react to the decision. */
  actionId?: string;
  doneAt?: string;
  snoozedUntil?: string;
}

interface Snapshot {
  status: Record<string, ItemState>;
  entries: PulseEntry[];
  presence: Presence[];
}
export interface WeaveState extends Snapshot {
  /** The last undoable change; the inbox toast offers Undo while it's fresh. */
  last?: { itemId: string; label: string; at: number; prev: Snapshot };
}

/** Asks wait on you; everything else is for you to read. */
export const ASK_KINDS: ItemKind[] = ["approval", "question", "escalation"];
export const isAsk = (item: InboxItem) => ASK_KINDS.includes(item.kind);
let inboxSeed = fixtureItems;
let calendar = fixtureCalendar as CalendarEvent[];
export const weaveItems = () => inboxSeed;
export const weaveCalendar = () => calendar;
export const weaveDayMarkers = () => httpMode ? [] : fixtureMarkers;
export const itemById = (id: string | null | undefined) => inboxSeed.find((i) => i.id === id);

let loadedAt = Date.now();
/** The mock clock keeps ticking from WEAVE_NOW, so decisions get plausible timestamps. */
/** When pinned (stories), the mock clock is frozen so repeated runs get identical timestamps. */
let timePin: string | undefined;
const mockNow = () => timePin ?? (httpMode ? new Date().toISOString() : new Date(WEAVE_NOW.getTime() + (Date.now() - loadedAt)).toISOString());

const initialWeaveState = (): WeaveState => ({
  status: Object.fromEntries(inboxSeed.map((i) => [i.id, {
    status: i.snoozedUntil ? "snoozed" : "open",
    unread: !!i.unread,
    snoozedUntil: i.snoozedUntil,
  } satisfies ItemState])),
  entries: pulseSeed,
  presence: presenceSeed,
});
let state: WeaveState = initialWeaveState();
let seq = 0;
const listeners = new Set<() => void>();

function set(next: WeaveState) {
  state = next;
  listeners.forEach((l) => l());
}
export function setWeaveSnapshot(next: WeaveSnapshot) {
  const prior = state.status;
  const serverIds = new Set(next.pulse.map((e) => e.id));
  inboxSeed = next.items;
  calendar = next.calendar;
  set({
    ...state,
    status: Object.fromEntries(next.items.map((i) => [i.id, prior[i.id] ?? {
      status: i.snoozedUntil ? "snoozed" : "open", unread: !!i.unread, snoozedUntil: i.snoozedUntil,
    } satisfies ItemState])),
    entries: [...state.entries.filter((e) => !serverIds.has(e.id) && /^(ev|po)-\d+$/.test(e.id)), ...next.pulse],
    presence: next.presence,
  });
}
const snapshot = (): Snapshot => ({ status: state.status, entries: state.entries, presence: state.presence });
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const patchItem = (id: string, patch: Partial<ItemState>) => ({ ...state.status, [id]: { ...state.status[id], ...patch } });
const patchEntry = (id: string, fn: (e: PulseEntry) => PulseEntry) => state.entries.map((e) => (e.id === id ? fn(e) : e));

export function useWeave() {
  return useSyncExternalStore(subscribe, () => state);
}

export function inboxGroups(s: WeaveState) {
  const open = inboxSeed.filter((i) => s.status[i.id].status === "open");
  const waitSince = (i: InboxItem) => (i.blocking ? new Date(i.blocking.since).getTime() : Infinity);
  return {
    // Blocking asks first, the longest wait on top; then asks that block nothing.
    needs: open.filter(isAsk).sort((a, b) => waitSince(a) - waitSince(b) || b.at.localeCompare(a.at)),
    forYou: open.filter((i) => !isAsk(i)).sort((a, b) => b.at.localeCompare(a.at)),
    snoozed: inboxSeed.filter((i) => s.status[i.id].status === "snoozed"),
    done: inboxSeed.filter((i) => s.status[i.id].status === "done")
      .sort((a, b) => (s.status[b.id].doneAt ?? "").localeCompare(s.status[a.id].doneAt ?? "")),
  };
}

/** Inbox rows in keyboard order (what j / k walk through). Snoozed rows are skipped. */
export function navigableIds(s: WeaveState, showDone: boolean) {
  const g = inboxGroups(s);
  return [...g.needs, ...g.forYou, ...(showDone ? g.done : [])].map((i) => i.id);
}

export function useNeedsYouCount() {
  return useSyncExternalStore(subscribe, () => inboxSeed.filter((i) => isAsk(i) && state.status[i.id].status === "open").length);
}

export const weave = {
  /** Resolves an ask: marks it done, posts what happened to Pulse, and lets the waiting agents resume. */
  resolve(itemId: string, actionId: string) {
    const item = itemById(itemId);
    const effect = item?.actions.find((a) => a.id === actionId)?.effect;
    if (!item || !effect) return;
    const now = mockNow();
    const added: PulseEntry[] = [];
    if (effect.event) added.push({ id: `ev-${++seq}`, kind: "event", actorId: "you", at: now, text: effect.event, quiet: effect.quiet });
    if (effect.policy) added.push({ id: `po-${++seq}`, kind: "policy", agentId: item.agentId, at: now, text: effect.policy });
    const changed = new Map((effect.presence ?? []).map((p) => [p.agentId, p]));
    const presence = state.presence.map((p): Presence => {
      const next = changed.get(p.agentId);
      if (next) return { ...next, since: now };
      // Anyone still waiting on this item resumes.
      if (p.itemId === itemId) return { agentId: p.agentId, state: "working", activity: p.activity, since: now };
      return p;
    });
    set({
      status: patchItem(itemId, { status: "done", unread: false, outcome: effect.outcome, actionId, doneAt: now }),
      entries: [...added, ...state.entries],
      presence,
      last: { itemId, label: effect.outcome, at: Date.now(), prev: snapshot() },
    });
  },
  snooze(itemId: string, until: string) {
    set({ ...state, status: patchItem(itemId, { status: "snoozed", snoozedUntil: until }), last: { itemId, label: `Snoozed · ${until}`, at: Date.now(), prev: snapshot() } });
  },
  unsnooze(itemId: string) {
    set({ ...state, status: patchItem(itemId, { status: "open", snoozedUntil: undefined }) });
  },
  /** For things you only needed to read. */
  markDone(itemId: string) {
    set({ ...state, status: patchItem(itemId, { status: "done", unread: false, outcome: "Done", doneAt: mockNow() }), last: { itemId, label: "Marked done", at: Date.now(), prev: snapshot() } });
  },
  markRead(itemId: string) {
    if (state.status[itemId]?.unread) set({ ...state, status: patchItem(itemId, { unread: false }) });
  },
  undo() {
    if (state.last) set({ ...state.last.prev });
  },
  toggleAck(entryId: string) {
    set({ ...state, entries: patchEntry(entryId, (e) => (e.kind === "update" ? { ...e, acked: !e.acked } : e)) });
  },
  reply(entryId: string, text: string) {
    const at = mockNow();
    set({ ...state, entries: patchEntry(entryId, (e) => (e.kind === "update" ? { ...e, replies: [...(e.replies ?? []), { text, at }] } satisfies UpdateEntry : e)) });
  },
  decideMemory(entryId: string, decision: "kept" | "forgotten" | undefined) {
    // Real rows (the pulse cards carry a memoryId) write through to the server: Keep pins,
    // Forget soft-deletes. Seeded mock rows stay client-only.
    const entry = state.entries.find((e) => e.id === entryId);
    if (entry?.kind === "memory" && entry.memoryId && decision) {
      void api.decideMemory(entry.memoryId, decision).catch((err: unknown) =>
        console.warn(`[weave] memory decision failed: ${err instanceof Error ? err.message : err}`));
    }
    set({ ...state, entries: patchEntry(entryId, (e) => (e.kind === "memory" ? { ...e, decision } : e)) });
  },
};

/**
 * Test seam (storybook harness only): restore the fixture seed, the state derived from it,
 * the pulse sequence and the mock clock, so every story run starts from the same world.
 * Production code never calls this.
 */
export function resetWeaveStore() {
  inboxSeed = fixtureItems;
  calendar = fixtureCalendar as CalendarEvent[];
  timePin = undefined;
  seq = 0;
  loadedAt = Date.now();
  state = initialWeaveState();
  listeners.forEach((l) => l());
}

/** Test seam: freeze the mock clock (pass undefined to let it tick from load again). */
export function pinMockNow(iso?: string) { timePin = iso; }
