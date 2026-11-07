// The small month grid Weave's day rail and the Schedule page share (extracted from
// weave/day-rail.tsx, SCH). Day keys are "YYYY-MM-DD"; the S-first columns match a week that
// starts on Sunday. Marks feed the dots and the day's title.
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { fullDayLabel, toKey, TODAY } from "@/components/weave/format";

export interface DayMark {
  label: string;
  kind: "deadline" | "activity";
}

export function MiniCalendar({ selected, onPick, marks, highlightWeek, today = TODAY }: {
  selected: string;
  onPick: (day: string) => void;
  /** The dots under a day (Weave: deadlines and activity; Schedule: days with routines). */
  marks?: (day: string) => DayMark[];
  /** Tint the whole selected week, not just the day (Schedule's week nav). */
  highlightWeek?: boolean;
  /** "YYYY-MM-DD" in the caller's zone. Weave's default is the mock clock's today. */
  today?: string;
}) {
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Array.from({ length: Math.ceil((offset + daysInMonth) / 7) * 7 }, (_, i) => toKey(new Date(Date.UTC(y, m - 1, 1 - offset + i))));
  const shift = (n: number) => setMonth(toKey(new Date(Date.UTC(y, m - 1 + n, 1))).slice(0, 7));
  const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
  const weekKeys = new Set<string>();
  if (highlightWeek) {
    const start = new Date(`${selected}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      weekKeys.add(toKey(d));
    }
  }
  return (
    <section>
      <div className="flex items-center px-1">
        <span className="text-xs font-medium">{monthFmt.format(first)}</span>
        <span className="ml-auto flex">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"><ChevronLeft className="size-3.5" /></button>
          <button type="button" aria-label="Next month" onClick={() => shift(1)} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"><ChevronRight className="size-3.5" /></button>
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-7 text-center text-[10px] text-muted-foreground">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="py-1">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {cells.map((key) => {
          const inMonth = key.slice(0, 7) === month;
          const dayMarks = marks?.(key) ?? [];
          const isSel = key === selected;
          return (
            <button
              key={key} type="button" onClick={() => onPick(key)}
              title={dayMarks.map((d) => d.label).join(" · ") || undefined}
              aria-pressed={isSel}
              aria-label={`${fullDayLabel(key)}${dayMarks.length ? ` · ${dayMarks.map((d) => d.label).join(", ")}` : ""}`}
              className={cn(
                "relative mx-auto flex size-8 items-center justify-center rounded-lg text-xs tabular-nums outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
                !inMonth && "text-muted-foreground/50",
                key === today && !isSel && "font-semibold ring-1 ring-inset ring-foreground/25",
                isSel && "bg-foreground font-semibold text-background hover:bg-foreground/90",
                !isSel && weekKeys.has(key) && "bg-foreground/[0.06] font-medium",
              )}
            >
              {Number(key.slice(8))}
              {dayMarks.length > 0 && (
                <span className="absolute bottom-1 left-1/2 flex -translate-x-1/2 gap-0.5">
                  {dayMarks.map((d) => <span key={d.label} className={cn("size-1 rounded-full", d.kind === "deadline" ? "bg-warn" : isSel ? "bg-background/70" : "bg-muted-foreground/60")} />)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
