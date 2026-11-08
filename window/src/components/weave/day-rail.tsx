import { CalendarDays } from "lucide-react";
import { weaveCalendar, weaveDayMarkers } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { httpMode } from "@/lib/api";
import { clockMinutes, dayKey, dayLabel, fmtTime, fromKey, TODAY, weaveNow } from "./format";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { ColumnLabel } from "./parts";

const START = 8 * 60, END = 20 * 60, PX = 0.7; // 8 AM–8 PM, px per minute
const EVENT_STYLE = {
  meeting: "border-run bg-run-soft/80",
  focus: "border-ok bg-ok-soft/80",
  personal: "border-foreground/25 bg-foreground/5",
} as const;

function Timebox({ day, onPickDay }: { day: string; onPickDay: (day: string) => void }) {
  const events = weaveCalendar().filter((e) => dayKey(e.start) === day);
  const upcoming = weaveDayMarkers()
    .filter((d) => d.kind === "deadline" && d.day >= day)
    .map((d) => ({ ...d, inDays: Math.round((fromKey(d.day).getTime() - fromKey(day).getTime()) / 86400000) }))
    .filter((d) => d.inDays <= 7);
  const now = clockMinutes(weaveNow());
  return (
    <section>
      <ColumnLabel right={day !== TODAY && (
        <button type="button" onClick={() => onPickDay(TODAY)} className="text-[11px] font-normal hover:text-foreground">Back to today</button>
      )}>
        {day === TODAY ? "Your day" : dayLabel(day)}
      </ColumnLabel>
      {upcoming.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 px-1">
          {upcoming.map((d) => (
            <span key={d.day} className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">
              <CalendarDays className="size-3" />{d.label}{d.inDays === 0 ? " · today" : ` in ${d.inDays} ${d.inDays === 1 ? "day" : "days"}`}
            </span>
          ))}
        </div>
      )}
      <div className="relative mt-2" style={{ height: (END - START) * PX }}>
        {Array.from({ length: (END - START) / 60 + 1 }, (_, i) => {
          const h = 8 + i;
          return (
            <div key={h} className="absolute inset-x-0 flex items-center gap-2" style={{ top: i * 60 * PX - 6 }}>
              <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{h % 12 || 12} {h < 12 ? "AM" : "PM"}</span>
              <span className="h-px flex-1 bg-foreground/[0.07]" />
            </div>
          );
        })}
        {events.map((e) => {
          const s = clockMinutes(e.start), en = clockMinutes(e.end);
          const past = day < TODAY || (day === TODAY && en <= now);
          return (
            <div
              key={e.id}
              className={cn("absolute left-11 right-1 overflow-hidden rounded-md border-l-2 px-2 py-0.5 text-[11px] leading-tight backdrop-blur", EVENT_STYLE[e.kind], past && "opacity-50")}
              style={{ top: (s - START) * PX, height: Math.max((en - s) * PX - 2, 16) }}
              title={`${e.title} · ${fmtTime(e.start)}–${fmtTime(e.end)}`}
            >
              <div className="truncate font-medium">{e.title}</div>
              {(en - s) * PX >= 30 && <div className="truncate text-muted-foreground">{fmtTime(e.start)}–{fmtTime(e.end)}</div>}
            </div>
          );
        })}
        {day === TODAY && now >= START && now <= END && (
          <div role="img" className="pointer-events-none absolute left-9 right-0 flex items-center" style={{ top: (now - START) * PX }} aria-label={`Now, ${fmtTime(weaveNow().toISOString())}`}>
            <span className="size-2 -translate-x-1 rounded-full bg-warn" />
            <span className="h-px flex-1 bg-warn" />
          </div>
        )}
        {events.length === 0 && <p className="absolute inset-x-11 top-16 text-center text-xs text-muted-foreground">Nothing on your calendar.</p>}
      </div>
      <p className="mt-3 px-1 text-[10px] text-muted-foreground">{httpMode ? "runs/calendar.json · read-only" : "Google Calendar · read-only, through the Studio Head's connector"}</p>
    </section>
  );
}

/** The "what's my day?" column: the mini calendar and the day's timebox. Who's working now lives at the top of the inbox (presence-strip.tsx). */
export function DayRail({ day, onPickDay }: { day: string; onPickDay: (day: string) => void }) {
  return (
    <div className="space-y-6 px-4 py-4">
      <MiniCalendar key={day.slice(0, 7)} selected={day} onPick={onPickDay} marks={(d) => weaveDayMarkers().filter((m) => m.day === d)} />
      <Timebox day={day} onPickDay={onPickDay} />
    </div>
  );
}
