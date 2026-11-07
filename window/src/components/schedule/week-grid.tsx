import { useEffect, useRef, useState } from "react";
import type { Occurrence } from "@fabric/contracts";
import { quietScroll } from "@/components/weave/use-edge-fade";
import { Face } from "@/components/weave/parts";
import { cn } from "@/lib/utils";
import { dayKey, dayHead, fmtTime, layoutColumns, minutesOfDay, monthDayLabel, weekDays } from "@/lib/schedule";
import type { Columns } from "@/lib/schedule";

const PX = 0.7; // px per minute, Weave's Timebox scale
const DAY_H = 24 * 60 * PX;
/** Where the scroller opens: 7 AM, just above the morning's routines. */
const SCROLL_TO = 7 * 60 * PX - 48;

/** State always reads as a word and a tint; skipped and missed fade and strike through. */
const STATE: Record<Occurrence["state"], { label: string; cls: string }> = {
  upcoming: { label: "Upcoming", cls: "border-dashed border-foreground/35 bg-background/70" },
  running: { label: "Running", cls: "border-run bg-run-soft/80" },
  accepted: { label: "Accepted", cls: "border-ok bg-ok-soft/80" },
  posted: { label: "Posted", cls: "border-ok bg-ok-soft/80" },
  blocked: { label: "Blocked", cls: "border-warn bg-warn-soft/80" },
  stopped: { label: "Stopped", cls: "border-foreground/25 bg-foreground/5" },
  skipped: { label: "Skipped", cls: "border-foreground/20 bg-background/40 opacity-55" },
  missed: { label: "Missed", cls: "border-foreground/20 bg-background/40 opacity-55" },
  failed: { label: "Failed", cls: "border-destructive/60 bg-destructive/10" },
};

interface Slot {
  occurrence: Occurrence;
  start: number;
  end: number;
  columns: Columns;
}

export function WeekGrid({ from, occurrences, todayKey, onSelect, onPickSlot }: {
  /** The week's Sunday, local. */
  from: Date;
  occurrences: Occurrence[];
  todayKey: string;
  onSelect: (occurrence: Occurrence) => void;
  /** A click on empty space: the day and the minute it landed on (rounded to 15). */
  onPickSlot: (day: string, minutes: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [nowMin, setNowMin] = useState(() => minutesOfDay(new Date().toISOString()));
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = SCROLL_TO;
    const timer = setInterval(() => setNowMin(minutesOfDay(new Date().toISOString())), 60_000);
    return () => clearInterval(timer);
  }, []);

  const days = weekDays(from);
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = dayKey(new Date(o.at));
    byDay.set(key, [...(byDay.get(key) ?? []), o]);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* The day heads sit above the scroller, so they stay put while the day scrolls. */}
      <div className="grid shrink-0 grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] items-baseline border-b border-foreground/10 bg-background/50 px-3 py-2 backdrop-blur-xl">
        <span />
        {days.map((d) => {
          const key = dayKey(d);
          return (
            <div key={key} className="text-center leading-tight">
              <div className={cn("text-xs", key === todayKey ? "font-semibold text-foreground" : "text-muted-foreground")}>{dayHead(d)}</div>
              <div className={cn("text-sm tabular-nums", key === todayKey ? "font-semibold" : "text-foreground/70")}>{monthDayLabel(d).split(" ")[1]}</div>
            </div>
          );
        })}
      </div>
      <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto", quietScroll)}>
        <div className="grid grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] px-3" style={{ height: DAY_H }}>
          {/* The hour gutter */}
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-2 -top-2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * 60 * PX }}>
                {h % 12 || 12} {h < 12 ? "AM" : "PM"}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const key = dayKey(d);
            const blocks = byDay.get(key) ?? [];
            const slots: Slot[] = (() => {
              const measured = blocks.map((o) => ({ occurrence: o, start: minutesOfDay(o.at), end: minutesOfDay(o.at) + Math.round((new Date(o.end).getTime() - new Date(o.at).getTime()) / 60_000) }));
              const columns = layoutColumns(measured);
              return measured.map((m, i) => ({ ...m, columns: columns[i]! }));
            })();
            return (
              <div
                key={key}
                className={cn("relative border-l border-foreground/[0.07]", key === todayKey && "bg-foreground/[0.025]")}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const minutes = Math.round(((e.clientY - rect.top) / PX) / 15) * 15;
                  onPickSlot(key, Math.max(0, Math.min(23 * 60 + 45, minutes)));
                }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="pointer-events-none absolute inset-x-0 border-t border-foreground/[0.06]" style={{ top: h * 60 * PX }} />
                ))}
                {slots.map(({ occurrence: o, start, end, columns: c }) => (
                  <button
                    key={o.at}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelect(o); }}
                    title={`${o.title} · ${STATE[o.state].label} · ${fmtTime(o.at)}`}
                    className={cn(
                      "absolute overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left text-[11px] leading-tight backdrop-blur-sm transition-[filter] hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
                      STATE[o.state].cls,
                      (o.state === "skipped" || o.state === "missed") && "line-through",
                      o.state === "running" && "ring-1 ring-run/40",
                    )}
                    style={{
                      top: start * PX,
                      height: Math.max((end - start) * PX - 2, 16),
                      left: `calc(${(c.col * 100) / c.cols}% + 2px)`,
                      right: `calc(${((c.cols - c.col - 1) * 100) / c.cols}% + 2px)`,
                    }}
                  >
                    <span className="flex items-center gap-1">
                      <Face id={o.agentId} size="size-3.5" />
                      <span className="min-w-0 truncate font-medium">{o.title}</span>
                      {o.state === "running" && <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-run" />}
                    </span>
                    {(end - start) * PX >= 30 && <span className="block truncate text-muted-foreground">{fmtTime(o.at)}–{fmtTime(o.end)}</span>}
                  </button>
                ))}
                {key === todayKey && (
                  <div role="img" className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowMin * PX }} aria-label="Now">
                    <span className="size-2 -translate-x-1/2 rounded-full bg-warn" />
                    <span className="h-px flex-1 bg-warn" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
