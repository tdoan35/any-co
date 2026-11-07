// Drag handles between Weave's columns. Widths are per viewer (localStorage, best effort) and are
// clamped so Pulse always keeps a readable middle column. Keyboard: focus a handle, ← / → move it
// 16px (Shift: 64px); double-click or Enter resets to the default.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export const PANE_LIMITS = {
  inbox: { min: 220, max: 480 },
  rail: { min: 240, max: 440 },
  /** Pulse never gets narrower than this; the side panes give way first. */
  center: 320,
} as const;

type Pane = "inbox" | "rail";
type Widths = Partial<Record<Pane, number>>;
const KEY = "anyco.weave.paneWidths";

function load(): Widths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Widths;
    return { inbox: typeof v.inbox === "number" ? v.inbox : undefined, rail: typeof v.rail === "number" ? v.rail : undefined };
  } catch { return {}; }
}
function save(w: Widths) {
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* private window: widths just don't stick */ }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * Resolved column widths for a panel of `panel` px. `defaults` apply until the viewer drags.
 * `hasRail` false = two columns (the rail is in a sheet), so only the inbox competes with Pulse.
 */
export function usePaneWidths(panel: number, defaults: Record<Pane, number>, hasRail: boolean) {
  const [stored, setStored] = useState<Widths>(load);
  const want = { inbox: stored.inbox ?? defaults.inbox, rail: stored.rail ?? defaults.rail };
  const rail = hasRail ? clamp(want.rail, PANE_LIMITS.rail.min, Math.min(PANE_LIMITS.rail.max, panel - PANE_LIMITS.center - PANE_LIMITS.inbox.min)) : 0;
  const inbox = clamp(want.inbox, PANE_LIMITS.inbox.min, Math.min(PANE_LIMITS.inbox.max, panel - PANE_LIMITS.center - rail));

  const set = useCallback((pane: Pane, px: number | undefined) => {
    setStored((s) => { const next = { ...s, [pane]: px === undefined ? undefined : Math.round(px) }; save(next); return next; });
  }, []);
  return { inbox, rail, set };
}

/**
 * A vertical separator sitting on a column border. `edge` is where the pane it sizes lies:
 * "left" (inbox: dragging right grows it) or "right" (rail: dragging left grows it).
 */
export function PaneHandle({ label, x, width, edge, min, max, onResize, onReset, onDragChange }: {
  label: string;
  /** Left offset of the border inside the panel, px. */
  x: number;
  width: number;
  edge: "left" | "right";
  min: number;
  max: number;
  onResize: (px: number) => void;
  onReset: () => void;
  /** True while a pointer drag is in progress (callers pause layout animations). */
  onDragChange?: (dragging: boolean) => void;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [active, setActive] = useState(false);
  const dir = edge === "left" ? 1 : -1;

  useEffect(() => () => { document.body.style.removeProperty("cursor"); document.body.style.removeProperty("user-select"); }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: width };
    setActive(true);
    onDragChange?.(true);
    // Keep the resize cursor and stop text selection while the pointer is over other panes.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(clamp(drag.current.startW + dir * (e.clientX - drag.current.startX), min, max));
  };
  const end = () => {
    if (drag.current) onDragChange?.(false);
    drag.current = null;
    setActive(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = (e.key === "ArrowRight" ? 1 : -1) * dir * step;
      onResize(clamp(width + delta, min, max));
    } else if (e.key === "Enter" || e.key === "Home") {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} · drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      style={{ left: x }}
      className="group/handle absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none"
    >
      <span className={cn(
        "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150",
        active ? "w-0.5 bg-run" : "bg-transparent group-hover/handle:bg-foreground/25 group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-ring",
      )} />
    </div>
  );
}
