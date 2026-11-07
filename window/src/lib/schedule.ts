// SCH: the calendar's local-time math. Unlike Weave's format.ts (Ty's fixed zone, the mock
// clock), this uses the viewer's own timezone and the real now — a schedule page is about when
// things run for you. Also the overlap layout that splits colliding blocks into columns.

export const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local "YYYY-MM-DD" for a date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight for a "YYYY-MM-DD" key. */
export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The Sunday of d's week, local (the mini calendar's S-first grid). */
export function weekStart(d: Date): Date {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

/** [from, to) for the week a `?week=` key (any day in it) points at, defaulting to this one. */
export function weekBounds(week?: string | null): { from: Date; to: Date; key: string } {
  const from = week ? weekStart(fromKey(week)) : weekStart(new Date());
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to, key: dayKey(from) };
}

export function weekDays(from: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/** Minutes since local midnight. */
export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
/** "8:00 AM", local. */
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

const shortDay = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const rangeFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "Sun", for column heads. */
export const dayHead = (d: Date) => shortDay.format(d);
/** "Oct 4". */
export const monthDayLabel = (d: Date) => monthDay.format(d);
/** "Oct 4 – 10" (same month) or "Sep 27 – Oct 3", for the header's range label. */
export function weekRangeLabel(from: Date): string {
  const end = new Date(from);
  end.setDate(end.getDate() + 6);
  const first = rangeFmt.format(from);
  const last = rangeFmt.format(end);
  return first.split(" ")[0] === last.split(" ")[0] ? `${first} – ${last.split(" ")[1]}` : `${first} – ${last}`;
}

/** `?occ=` identity: the occurrence's schedule and slot, as one token. */
export const occKey = (o: { scheduleId: string; at: string }) => `${o.scheduleId}@${o.at}`;
export function parseOccKey(key: string): { scheduleId: string; at: string } | undefined {
  const at = key.slice(key.indexOf("@") + 1);
  const scheduleId = key.slice(0, key.indexOf("@"));
  return scheduleId && at ? { scheduleId, at } : undefined;
}

// ---- overlap layout ----

export interface Columns {
  /** 0-based column within the cluster. */
  col: number;
  /** How many columns the cluster spans (divide the width by this). */
  cols: number;
}

/**
 * Splits overlapping blocks into side-by-side columns: a cluster is a chain of blocks that
 * transitively overlap; within it, each block takes the leftmost column free at its start.
 * Returns positions aligned with the input order.
 */
export function layoutColumns<T extends { start: number; end: number }>(blocks: T[]): Columns[] {
  const out: Columns[] = blocks.map(() => ({ col: 0, cols: 1 }));
  const order = blocks.map((b, i) => i).sort((a, b) => blocks[a].start - blocks[b].start || a - b);
  let cluster: number[] = [];
  let clusterEnd = -1;
  const columnEnds: number[] = [];
  const flush = () => {
    if (!cluster.length) return;
    for (const i of cluster) out[i] = { col: out[i].col, cols: columnEnds.length };
    cluster = [];
    columnEnds.length = 0;
  };
  for (const i of order) {
    const b = blocks[i];
    if (cluster.length && b.start >= clusterEnd) flush();
    let col = columnEnds.findIndex((end) => end <= b.start);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(b.end);
    } else {
      columnEnds[col] = b.end;
    }
    out[i] = { col, cols: 1 };
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}
