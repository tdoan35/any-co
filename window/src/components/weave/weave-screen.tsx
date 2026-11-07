import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Segmented, headerButton, headerTitle } from "@/components/studio/studio-ui";
import { isAsk, itemById, navigableIds, useWeave, weave } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { DayRail } from "./day-rail";
import { fullDayLabel, greeting, shortDayLabel, TODAY } from "./format";
import { Inbox } from "./inbox";
import { ItemDetail } from "./item-detail";
import { ColumnHeader } from "./parts";
import { Pulse, type PulseFilter } from "./pulse";
import { quietScroll, useEdgeFade } from "./use-edge-fade";

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
    if (window.matchMedia("(max-width: 1023px)").matches) el.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        case "s": if (item && state.status[item.id].status === "open") setSnoozeFor(item.id); break;
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        center={<span className="hidden animate-in fade-in text-sm font-medium duration-700 fill-mode-backwards md:inline">{greeting()}</span>}
        right={<>
          {/* The rail's "Today" header carries the date; it only shows here while the rail is hidden. */}
          <span className="hidden text-xs text-muted-foreground sm:inline xl:hidden">{fullDayLabel(TODAY)}</span>
          <Button size="sm" variant="outline" className={cn(headerButton, "xl:hidden")} onClick={() => setRailOpen(true)}><CalendarDays />Your day</Button>
        </>}
      >
        <span className={headerTitle}>Weave</span>
      </PageHeader>
      <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
        <div className={cn(
          "grid h-full grid-cols-1 overflow-y-auto rounded-2xl border border-foreground/10 bg-background/20 shadow-sm backdrop-blur-xl lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[300px_minmax(0,1fr)_288px]",
          quietScroll,
        )}>
          <section aria-label="Inbox" className="flex max-h-[60vh] min-h-0 flex-col border-b border-foreground/10 bg-background/40 lg:max-h-none lg:border-b-0 lg:border-r">
            <Inbox
              state={state} selectedId={selectedId} focusId={selectedId ?? focusId} onOpen={open}
              snoozeFor={snoozeFor} setSnoozeFor={setSnoozeFor}
              showDone={showDone} onToggleDone={() => setShowDone((v) => !v)}
            />
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
            <div ref={centerRef} style={centerFade} className={cn("min-h-0 flex-1 px-5 pb-5 pt-4 lg:overflow-y-auto", quietScroll)}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={selected?.id ?? "pulse"}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
                >
                  {selected
                    ? <ItemDetail item={selected} st={state.status[selected.id]} last={state.last} />
                    : <Pulse state={state} filter={filter} onFilter={setFilter} onSelectItem={open} scrollTo={scrollTo} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </section>
          <aside aria-label="Today" className="hidden min-h-0 flex-col border-l border-foreground/10 bg-background/40 xl:flex">
            <ColumnHeader>{todayTitle}</ColumnHeader>
            <div ref={railRef} style={railFade} className={cn("min-h-0 flex-1 overflow-y-auto", quietScroll)}>{rail}</div>
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
