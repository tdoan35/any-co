// ui-lint: deterministic layout checks over the optional ui[] of state dumps (docs/contracts/state-dump.md).
// Pure functions: the CLI and tests feed the same dumps. Findings carry {check, ids, rects, tick}.
// Release-gate rule: ui[] absent => not implemented (not pass).

export interface UiElement {
  id: string;
  rect: [number, number, number, number]; // [x, y, w, h], viewport px, origin top-left
  z: number;
  visible: boolean;
  overlay?: boolean;
  text_px?: number;
  parent?: string;
  contains?: string[];
}

export interface UiLintOptions {
  viewport?: [number, number]; // [w, h]; default from --resolution 1280x720
  minTextPx?: number; // default 10
  gridPx?: number; // when set, x/y must be multiples of this
}

export interface Finding {
  check: "overlap" | "offscreen" | "text_px" | "grid";
  ids: string[];
  rects: number[][] | null;
  tick: number;
  detail: string;
}

export interface UiLintResult {
  /** "ok" = checks ran and passed; "not-implemented" = no ui[] in any dump. */
  status: "ok" | "not-implemented";
  findings: Finding[];
  dumpsChecked: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function uiOf(dump: unknown): { elements: UiElement[]; tick: number } | null {
  if (!isObj(dump)) return null;
  const raw = dump["ui"];
  if (!Array.isArray(raw)) return null; // absent: not implemented for this dump
  const tick = num(dump["tick"]) ?? 0;
  const elements: UiElement[] = [];
  for (const e of raw) {
    if (!isObj(e)) continue;
    const id = e["id"];
    const rect = Array.isArray(e["rect"]) ? (e["rect"] as unknown[]).map(num) : undefined;
    const z = num(e["z"]);
    if (typeof id !== "string" || !rect || rect.length !== 4 || rect.some((n) => n === undefined) || z === undefined) continue;
    elements.push({
      id,
      rect: rect as [number, number, number, number],
      z,
      visible: e["visible"] === true,
      overlay: e["overlay"] === true || undefined,
      text_px: num(e["text_px"]),
      parent: typeof e["parent"] === "string" ? e["parent"] : undefined,
      contains: Array.isArray(e["contains"]) ? (e["contains"] as unknown[]).filter((s): s is string => typeof s === "string") : undefined,
    });
  }
  return { elements, tick };
}

function intersectionArea(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function related(a: UiElement, b: UiElement, byId: Map<string, UiElement>): boolean {
  // related when both sit in one containment component: parent (child -> parent) and contains
  // (parent -> child) edges, UNDIRECTED and transitive — hud-mp-xpy relates hud and xpy.
  const component = new Set<string>([a.id]);
  const queue: string[] = [a.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === b.id) return true;
    const e = cur === a.id ? a : byId.get(cur);
    if (!e) continue;
    const neighbors: string[] = [];
    if (e.parent) neighbors.push(e.parent);
    if (e.contains) neighbors.push(...e.contains);
    for (const other of byId.values()) {
      if (other.parent === cur) neighbors.push(other.id);
      if (other.contains?.includes(cur)) neighbors.push(other.id);
    }
    for (const n of neighbors) {
      if (!component.has(n)) {
        component.add(n);
        queue.push(n);
      }
    }
  }
  return false;
}

/** All findings across the given dumps, in dump order then check order. Deterministic. */
export function uiLint(dumps: unknown[], opts: UiLintOptions = {}): UiLintResult {
  const viewport = opts.viewport ?? [1280, 720];
  const minTextPx = opts.minTextPx ?? 10;
  const gridPx = opts.gridPx;
  const parsed = dumps.map(uiOf).filter((d): d is { elements: UiElement[]; tick: number } => d !== null);
  if (parsed.length === 0) return { status: "not-implemented", findings: [], dumpsChecked: 0 };

  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  for (const { elements, tick } of parsed) {
    const visible = elements.filter((e) => e.visible);

    // (a) overlaps between visible non-overlay elements, unless parent/child or declared contains
    const byId = new Map<string, UiElement>(elements.map((e) => [e.id, e]));
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i]!;
        const b = visible[j]!;
        if (a.overlay || b.overlay || related(a, b, byId)) continue;
        const area = intersectionArea(a.rect, b.rect);
        if (area > 0) {
          add({
            check: "overlap",
            ids: [a.id, b.id],
            rects: [a.rect, b.rect],
            tick,
            detail: `overlap area ${Math.round(area)}px²`,
          });
        }
      }
    }

    // (b) off-screen or clipped: any part outside the viewport
    const [vw, vh] = viewport;
    for (const e of visible) {
      const [x, y, w, h] = e.rect;
      if (x < 0 || y < 0 || x + w > vw || y + h > vh) {
        add({
          check: "offscreen",
          ids: [e.id],
          rects: [e.rect],
          tick,
          detail: `rect [${e.rect.join(", ")}] outside viewport ${vw}x${vh}`,
        });
      }
    }

    // (c) text too small
    for (const e of visible) {
      if (e.text_px !== undefined && e.text_px < minTextPx) {
        add({ check: "text_px", ids: [e.id], rects: [e.rect], tick, detail: `text_px ${e.text_px} < ${minTextPx}` });
      }
    }

    // (d) optional grid snap on x/y
    if (gridPx !== undefined && gridPx > 0) {
      for (const e of visible) {
        const [x, y] = e.rect;
        const offX = Math.abs(((x % gridPx) + gridPx) % gridPx);
        const offY = Math.abs(((y % gridPx) + gridPx) % gridPx);
        if (offX > 1e-9 || offY > 1e-9) {
          add({ check: "grid", ids: [e.id], rects: [e.rect], tick, detail: `x=${x} y=${y} off the ${gridPx}px grid` });
        }
      }
    }
  }

  return { status: "ok", findings, dumpsChecked: parsed.length };
}
