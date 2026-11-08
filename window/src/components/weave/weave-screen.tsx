import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Segmented, headerButton, headerTitle } from "@/components/studio/studio-ui";
import { inboxGroups, isAsk, itemById, navigableIds, useWeave, weave } from "@/lib/weave-store";
import { httpMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DayRail } from "./day-rail";
import { fullDayLabel, greeting, shortDayLabel, TODAY } from "./format";
import { Inbox } from "./inbox";
import { ItemDetail } from "./item-detail";
import { ColumnHeader } from "./parts";
import { COLLAPSED_PX, CollapsedStrip, PANE_LIMITS, PaneHandle, PaneToggle, usePaneWidths } from "./pane-resize";
import { Pulse, type PulseFilter } from "./pulse";
import { quietScroll, useEdgeFade } from "./use-edge-fade";

/** Panel widths (px) where the layout gains a column. Measured on the panel, not the viewport, so the
 *  app sidebar and a small display (or a narrow Electron window) don't push the day rail into a sheet. */
const TWO_COLS = 680;
const THREE_COLS = 860;
/** Default inbox width: Fabric's 300px above this panel width, 264px below it, so Pulse keeps a readable width.
 *  Dragging a column border overrides the defaults (pane-resize.tsx). */
const ROOMY = 1100;

function usePanelWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * One layer of a side column: pinned to its outer edge at a fixed width (the column's border excluded),
 * so the column's own width animates over it like a drawer. Hidden layers fade out and go inert.
 */
function Layer({ side, width, shown, children }: { side: "left" | "right"; width: number; shown: boolean; children: React.ReactNode }) {
  return (
    <div
      inert={!shown}
      aria-hidden={!shown || undefined}
      style={{ width: `calc(${width}px - 1px)` }}
      className={cn(
        "absolute inset-y-0 flex flex-col transition-opacity duration-200 motion-reduce:transition-none",
        side === "left" ? "left-0" : "right-0",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {children}
    </div>
  );
}

const FILTERS = [{ value: "highlights", label: "Highlights" }, { value: "everything", label: "Everything" }] as const;

/**
 * Weave: where your organization reports to you.
 * Inbox (what needs me?) · Pulse or the open item (what changed?) · presence and your day (who's working, what's my day?).
 * Calm by default (PRODUCT §8.1): no live logs, no red badges, and quiet events stay under Everything.
 */
export function WeaveScreen() {
  const state = useWeave();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = itemById(params.get("item"))?.id ?? null;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState<PulseFilter>("highlights");
  const [day, setDay] = useState(TODAY);
  const [scrollTo, setScrollTo] = useState<{ day: string; n: number } | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [centerRef, centerFade] = useEdgeFade<HTMLDivElement>();
  const [railRef, railFade] = useEdgeFade<HTMLDivElement>();
  const [panelRef, panelWidth] = usePanelWidth<HTMLDivElement>();
  // Before the first measurement (width 0) assume the common desktop case: three columns.
  const cols = panelWidth === 0 || panelWidth >= THREE_COLS ? 3 : panelWidth >= TWO_COLS ? 2 : 1;
  useEffect(() => { if (cols === 3) setRailOpen(false); }, [cols]);
  // Pulse rows animate their position; while a border is dragged that animation chases every pixel.
  const [resizing, setResizing] = useState(false);
  const panes = usePaneWidths(panelWidth, { inbox: panelWidth >= ROOMY ? 300 : 264, rail: 288 }, cols === 3);
  // Measured: explicit widths from the drag state. Unmeasured first frame: the static default.
  const template = panelWidth === 0 || cols === 1 ? undefined
    : cols === 3 ? `${panes.inbox}px minmax(0,1fr) ${panes.rail}px` : `${panes.inbox}px minmax(0,1fr)`;
  const colsRef = useRef(cols);
  colsRef.current = cols;

  // The open item lives in the URL, so the title bar's back / forward walks through what you opened.
  const open = useCallback((id: string) => {
    setFocusId(id);
    setRailOpen(false);
    setParams((p) => { const n = new URLSearchParams(p); n.set("item", id); return n; });
  }, [setParams]);
  const close = useCallback(() => setParams((p) => { const n = new URLSearchParams(p); n.delete("item"); return n; }), [setParams]);

  useEffect(() => {
    if (!selectedId) return;
    weave.markRead(selectedId);
    const el = centerRef.current;
    if (!el) return;
    el.scrollTo({ top: 0 });
    // Stacked layout (narrow window): bring the detail into view below the inbox.
    if (colsRef.current === 1) el.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId, centerRef]);

  const pickDay = (d: string) => {
    setDay(d);
    if (selectedId) close();
    setScrollTo((s) => ({ day: d, n: (s?.n ?? 0) + 1 }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest("input, textarea, [contenteditable='true']")) return;
      // Open menus and sheets own the keyboard.
      if (document.querySelector("[role='menu'], [role='dialog']")) return;
      const ids = navigableIds(state, showDone);
      const cur = selectedId ?? focusId;
      const idx = cur ? ids.indexOf(cur) : -1;
      const item = itemById(cur);
      const move = (to: string | undefined) => {
        if (!to) return;
        setFocusId(to);
        if (selectedId) open(to);
        document.querySelector(`[data-item="${to}"]`)?.scrollIntoView({ block: "nearest" });
      };
      switch (e.key) {
        case "j": move(ids[Math.min(ids.length - 1, idx + 1)]); break;
        case "k": move(ids[Math.max(0, idx - 1)]); break;
        case "Enter": if (focusId && !selectedId) open(focusId); else return; break;
        case "Escape": if (selectedId) close(); else return; break;
        case "e":
          // Asks need a decision; "done" is for things you only had to read.
          if (item && !isAsk(item) && state.status[item.id].status === "open") weave.markDone(item.id);
          break;
        case "s": if (!httpMode && item && state.status[item.id].status === "open") setSnoozeFor(item.id); else return; break;
        case "a": {
          const primary = item?.actions.find((a) => a.variant === "primary");
          if (!item || !primary || state.status[item.id].status !== "open") return;
          if (primary.href) navigate(primary.href);
          else weave.resolve(item.id, primary.id);
          break;
        }
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, showDone, selectedId, focusId, open, close, navigate]);

  const selected = itemById(selectedId);
  const rail = <DayRail state={state} day={day} onPickDay={pickDay} onSelectItem={open} />;
  const todayTitle = <><h2 className="text-sm font-semibold">Today</h2><span className="text-xs text-muted-foreground">{shortDayLabel(TODAY)}</span></>;
  const inboxCollapsed = cols > 1 && panes.collapsed.inbox;
  const railCollapsed = cols === 3 && panes.collapsed.rail;
  const needsYou = inboxGroups(state).needs.length;
  const inbox = (onCollapse: (() => void) | undefined) => (
    <Inbox
      state={state} selectedId={selectedId} focusId={selectedId ?? focusId} onOpen={open}
      snoozeFor={snoozeFor} setSnoozeFor={setSnoozeFor}
      showDone={showDone} onToggleDone={() => setShowDone((v) => !v)}
      onCollapse={onCollapse}
    />
  );
  const working = state.presence.filter((p) => p.state === "working").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        center={<span className="hidden animate-in fade-in text-sm font-medium duration-700 fill-mode-backwards md:inline">{greeting()}</span>}
        right={<>
          {/* The rail's "Today" header carries the date; it only shows here while the rail is hidden. */}
          {cols < 3 && <>
            <span className="hidden text-xs text-muted-foreground sm:inline">{fullDayLabel(TODAY)}</span>
            <Button size="sm" variant="outline" className={headerButton} onClick={() => setRailOpen(true)}><CalendarDays />Your day</Button>
          </>}
        </>}
      >
        <span className={headerTitle}>Weave</span>
      </PageHeader>
      <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
        <div ref={panelRef} style={{ gridTemplateColumns: template }} className={cn(
          "relative grid h-full rounded-2xl border border-foreground/10 bg-background/20 shadow-sm backdrop-blur-xl",
          cols === 1 ? "grid-cols-1 overflow-y-auto" : "overflow-hidden",
          panelWidth === 0 && "grid-cols-[300px_minmax(0,1fr)_288px]",
          panes.animating && "transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          quietScroll,
        )}>
          {template && !inboxCollapsed && (
            <PaneHandle
              label="Resize inbox" edge="left" x={panes.inbox} width={panes.inbox}
              min={PANE_LIMITS.inbox.min} max={Math.min(PANE_LIMITS.inbox.max, panelWidth - PANE_LIMITS.center - panes.rail)}
              onResize={(px) => panes.set("inbox", px)} onReset={() => panes.set("inbox", undefined)} onDragChange={setResizing}
            />
          )}
          {template && cols === 3 && !railCollapsed && (
            <PaneHandle
              label="Resize day rail" edge="right" x={panelWidth - panes.rail} width={panes.rail}
              min={PANE_LIMITS.rail.min} max={Math.min(PANE_LIMITS.rail.max, panelWidth - PANE_LIMITS.center - panes.inbox)}
              onResize={(px) => panes.set("rail", px)} onReset={() => panes.set("rail", undefined)} onDragChange={setResizing}
            />
          )}
          <section aria-label="Inbox" className={cn(
            "relative flex min-h-0 flex-col border-foreground/10 bg-background/40",
            cols === 1 ? "max-h-[60vh] border-b" : "overflow-hidden border-r",
          )}>
            {cols === 1 ? inbox(undefined) : <>
              {/* Drawer: the inbox keeps its open width and the column edge slides over it, so nothing
                  reflows mid-animation; it crossfades with the strip. Both stay mounted. */}
              <Layer side="left" width={panes.open.inbox} shown={!inboxCollapsed}>{inbox(() => panes.toggle("inbox"))}</Layer>
              <Layer side="left" width={COLLAPSED_PX} shown={inboxCollapsed}>
                <CollapsedStrip side="left" label="Inbox" name="inbox" count={needsYou} countTone="bg-warn-soft text-warn"
                  countLabel={`${needsYou} waiting on you`} onExpand={() => panes.toggle("inbox")} />
              </Layer>
            </>}
          </section>
          <section aria-label={selected ? selected.title : "Pulse"} className="flex min-h-0 scroll-mt-4 flex-col">
            <ColumnHeader className="px-5">
              {selected
                ? (
                  <button type="button" onClick={close} className="-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-foreground/5">
                    <ArrowLeft className="size-3.5" />Pulse<kbd className="ml-1 rounded border border-foreground/15 px-1 font-mono text-[10px] font-normal text-muted-foreground">esc</kbd>
                  </button>
                )
                : <>
                    <h2 className="text-sm font-semibold">Pulse</h2>
                    <span className="ml-auto"><Segmented value={filter} options={FILTERS} onChange={setFilter} /></span>
                  </>}
            </ColumnHeader>
            <div ref={centerRef} style={centerFade} className={cn("min-h-0 flex-1 px-5 pb-5 pt-4", cols > 1 && "overflow-y-auto", quietScroll)}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={selected?.id ?? "pulse"}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
                >
                  {selected
                    ? <ItemDetail item={selected} st={state.status[selected.id]} last={state.last} />
                    : <Pulse state={state} filter={filter} onFilter={setFilter} onSelectItem={open} scrollTo={scrollTo} animateLayout={!resizing && !panes.animating} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </section>
          <aside aria-label="Today" className={cn("relative min-h-0 overflow-hidden border-l border-foreground/10 bg-background/40", cols === 3 ? "block" : "hidden")}>
            {/* Same drawer as the inbox, anchored right. The rail body stays mounted (its edge-fade
                observers attach once, on mount). */}
            <Layer side="right" width={panes.open.rail} shown={!railCollapsed}>
              <ColumnHeader className="pr-2">
                {todayTitle}
                <PaneToggle side="right" collapsed={false} label="day rail" onToggle={() => panes.toggle("rail")} className="ml-auto" />
              </ColumnHeader>
              <div ref={railRef} style={railFade} className={cn("min-h-0 flex-1 overflow-y-auto", quietScroll)}>{rail}</div>
            </Layer>
            <Layer side="right" width={COLLAPSED_PX} shown={railCollapsed}>
              <CollapsedStrip side="right" label="Today" name="day rail" count={working} countTone="bg-run-soft text-run"
                countLabel={`${working} working`} onExpand={() => panes.toggle("rail")} />
            </Layer>
          </aside>
        </div>
      </div>
      <Sheet open={railOpen} onOpenChange={setRailOpen}>
        <SheetContent side="right" aria-describedby={undefined} className="w-[320px] gap-0 bg-background/90 p-0 backdrop-blur-xl">
          <ColumnHeader className="pr-12">
            <SheetTitle className="text-sm font-semibold">Today</SheetTitle>
            <span className="text-xs text-muted-foreground">{shortDayLabel(TODAY)}</span>
          </ColumnHeader>
          <div className={cn("min-h-0 flex-1 overflow-y-auto", quietScroll)}>{rail}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
