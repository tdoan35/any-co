// Drag handles and collapse toggles for Weave's side columns. Widths and collapsed state are per
// viewer (localStorage, best effort); widths are clamped so Pulse always keeps a readable middle
// column. Keyboard: focus a handle, ← / → move it 16px (Shift: 64px); double-click or Enter resets.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export const PANE_LIMITS = {
  inbox: { min: 220, max: 480 },
  rail: { min: 240, max: 440 },
  /** Pulse never gets narrower than this; the side panes give way first. */
  center: 320,
} as const;

/** A collapsed side column keeps a strip this wide: the expand button and a count. */
export const COLLAPSED_PX = 44;
/** Collapse / expand animation length; the grid transition is only switched on for this long. */
export const PANE_ANIM_MS = 300;

type Pane = "inbox" | "rail";
type Widths = Partial<Record<Pane, number>> & { collapsed?: Partial<Record<Pane, boolean>> };
const KEY = "anyco.weave.paneWidths";

function load(): Widths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Widths;
    const c = v.collapsed ?? {};
    return {
      inbox: typeof v.inbox === "number" ? v.inbox : undefined,
      rail: typeof v.rail === "number" ? v.rail : undefined,
      collapsed: { inbox: c.inbox === true, rail: c.rail === true },
    };
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
  const collapsed = { inbox: !!stored.collapsed?.inbox, rail: hasRail && !!stored.collapsed?.rail };
  const inboxFloor = collapsed.inbox ? COLLAPSED_PX : PANE_LIMITS.inbox.min;
  const rail = !hasRail ? 0 : collapsed.rail ? COLLAPSED_PX
    : clamp(want.rail, PANE_LIMITS.rail.min, Math.min(PANE_LIMITS.rail.max, panel - PANE_LIMITS.center - inboxFloor));
  const openInbox = clamp(want.inbox, PANE_LIMITS.inbox.min, Math.min(PANE_LIMITS.inbox.max, panel - PANE_LIMITS.center - rail));
  const inbox = collapsed.inbox ? COLLAPSED_PX : openInbox;
  const openRail = !hasRail ? 0
    : clamp(want.rail, PANE_LIMITS.rail.min, Math.min(PANE_LIMITS.rail.max, panel - PANE_LIMITS.center - inbox));
  /** What each pane measures when expanded: its content keeps this width while the column animates. */
  const open = { inbox: openInbox, rail: openRail };

  // The grid only transitions while a collapse/expand plays, never while dragging or resizing the window.
  const [animating, setAnimating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const update = useCallback((patch: (s: Widths) => Widths) => {
    setStored((s) => { const next = patch(s); save(next); return next; });
  }, []);
  const set = useCallback((pane: Pane, px: number | undefined) =>
    update((s) => ({ ...s, [pane]: px === undefined ? undefined : Math.round(px) })), [update]);
  const toggle = useCallback((pane: Pane) => {
    setAnimating(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnimating(false), PANE_ANIM_MS + 60);
    update((s) => ({ ...s, collapsed: { ...s.collapsed, [pane]: !s.collapsed?.[pane] } }));
  }, [update]);
  return { inbox, rail, open, collapsed, animating, set, toggle };
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

/** What a collapsed side column leaves behind: the expand button, a count, and the column's name
 *  set vertically. The whole strip expands on click; only the button is in the tab order. */
export function CollapsedStrip({ side, label, name, count, countTone, countLabel, onExpand }: {
  side: "left" | "right";
  /** Shown vertically in the strip. */
  label: string;
  /** For the button: "Expand <name>", matching the header's "Collapse <name>". */
  name: string;
  count: number; countTone: string; countLabel: string; onExpand: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center">
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-foreground/10">
        <PaneToggle side={side} collapsed label={name} onToggle={onExpand} />
      </div>
      <button type="button" tabIndex={-1} aria-hidden onClick={onExpand}
        className="flex w-full flex-1 flex-col items-center gap-2.5 pt-3 transition-colors hover:bg-foreground/[0.03]">
        {count > 0 && <span className={cn("min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-medium tabular-nums", countTone)} title={countLabel}>{count}</span>}
        <span className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">{label}</span>
      </button>
      {count > 0 && <span className="sr-only">{countLabel}</span>}
    </div>
  );
}

/** Collapse / expand button for a side column. `side` is where the column sits. */
export function PaneToggle({ side, collapsed, label, onToggle, className }: {
  side: "left" | "right"; collapsed: boolean; label: string; onToggle: () => void; className?: string;
}) {
  const Icon = side === "left" ? (collapsed ? PanelLeftOpen : PanelLeftClose) : (collapsed ? PanelRightOpen : PanelRightClose);
  const text = `${collapsed ? "Expand" : "Collapse"} ${label}`;
  return (
    <button type="button" onClick={onToggle} aria-label={text} aria-expanded={!collapsed} title={text}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}>
      <Icon className="size-4" />
    </button>
  );
}
