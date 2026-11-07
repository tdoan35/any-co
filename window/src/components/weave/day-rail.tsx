import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CalendarDays, ChevronLeft, ChevronRight, EyeOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Presence, type PresenceState } from "@/lib/mock/weave";
import { weaveCalendar, weaveDayMarkers, type WeaveState } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { clockMinutes, dayKey, dayLabel, fmtTime, fromKey, TODAY, weaveNow } from "./format";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { ColumnLabel, Face, agentOf } from "./parts";

const STATE: Record<PresenceState, { label: string; ring: string; dot: string; text: string }> = {
  working: { label: "Working", ring: "ring-run", dot: "bg-run", text: "text-run" },
  waiting: { label: "Waiting on you", ring: "ring-warn", dot: "bg-warn", text: "text-warn" },
  blocked: { label: "Blocked", ring: "ring-warn/40", dot: "bg-warn/50", text: "text-muted-foreground" },
  idle: { label: "Idle", ring: "ring-foreground/10", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

function PresenceFace({ p, onClick }: { p: Presence; onClick: () => void }) {
  const s = STATE[p.state];
  const a = agentOf(p.agentId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onClick} className="group flex w-14 flex-col items-center rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className={cn("relative flex shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-transparent transition-transform group-hover:scale-105", s.ring)}>
            <Face id={p.agentId} size="size-10" />
            <span className="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full bg-background">
              <span className={cn("relative size-2 rounded-full", s.dot)}>
                {p.state === "waiting" && <span aria-hidden className={cn("absolute inset-0 rounded-full animate-[dot-pulse_2.2s_ease-out_infinite] motion-reduce:hidden", s.dot)} />}
              </span>
            </span>
          </span>
          <span className="mt-1.5 max-w-full truncate text-[11px] font-medium">{a.name}</span>
          <span className={cn("max-w-full truncate text-[10px]", s.text)}>{p.state === "waiting" ? "Needs you" : s.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56">
        <div className="space-y-0.5">
          <div className="font-medium">{a.name} · {a.role}</div>
          <div>{s.label}: {p.activity}</div>
          <div className="opacity-70">since {fmtTime(p.since)}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Who needs you comes first, so the strip's overflow never hides someone waiting on you. */
const URGENCY: Record<PresenceState, number> = { waiting: 0, blocked: 1, working: 2, idle: 3 };

function StripButton({ side, show, onClick }: { side: "left" | "right"; show: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous agents" : "More agents"}
      onClick={onClick}
      tabIndex={show ? 0 : -1}
      className={cn(
        "absolute top-[25px] z-10 -mt-3 grid size-6 place-items-center rounded-full bg-background/90 text-muted-foreground shadow-sm ring-1 ring-foreground/10 backdrop-blur transition-opacity hover:text-foreground",
        side === "left" ? "-left-2" : "-right-2",
        show ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/**
 * One row, never wrapping: waiting → blocked → working, with idle agents folded into a "+N" tile
 * that reveals them. When the row overflows, chevrons page through it (same pattern as Agent Studio's carousel).
 */
function PresenceStrip({ presence, onSelectItem }: { presence: Presence[]; onSelectItem: (id: string) => void }) {
  const navigate = useNavigate();
  const [showIdle, setShowIdle] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 2, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    // ResizeObserver reports on observe; watching the row too catches agents being revealed or hidden.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", measure); };
  }, []);

  const sorted = [...presence].sort((a, b) => URGENCY[a.state] - URGENCY[b.state]);
  const idle = sorted.filter((p) => p.state === "idle");
  const shown = showIdle ? sorted : sorted.filter((p) => p.state !== "idle");
  const count = (s: PresenceState) => presence.filter((p) => p.state === s).length;
  const summary = (["waiting", "working", "blocked"] as const).filter((s) => count(s)).map((s) => `${count(s)} ${s === "waiting" ? "waiting on you" : s}`);
  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.75, behavior: "smooth" });
  const toggleIdle = () => {
    setShowIdle((v) => !v);
    // Bring the first revealed agent into view once it has rendered.
    if (!showIdle && idle[0]) setTimeout(() => ref.current?.querySelector(`[data-agent="${idle[0].agentId}"]`)?.scrollIntoView({ inline: "start", block: "nearest", behavior: "smooth" }), 50);
  };
  const fade = 24;
  const mask = `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black ${fade}px, black calc(100% - ${fade}px), ${edges.right ? "transparent" : "black"})`;

  return (
    <section>
      <ColumnLabel>Now</ColumnLabel>
      <div className="relative mt-1.5">
        <div ref={ref} className="snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ maskImage: mask, WebkitMaskImage: mask }}>
          <div className="flex w-max gap-1.5 py-1">
            {shown.map((p) => (
              <div key={p.agentId} data-agent={p.agentId} className="snap-start">
                <PresenceFace p={p}
                  onClick={() => (p.state === "waiting" && p.itemId ? onSelectItem(p.itemId) : navigate(`/agents?agent=${p.agentId}`))} />
              </div>
            ))}
            {idle.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={toggleIdle} aria-pressed={showIdle}
                    className="group flex w-14 snap-start flex-col items-center rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex size-10 items-center justify-center rounded-full bg-foreground/5 text-xs font-medium text-muted-foreground ring-2 ring-foreground/10 ring-offset-2 ring-offset-transparent transition-colors group-hover:bg-foreground/10 group-hover:text-foreground">
                      {showIdle ? <EyeOff className="size-4" /> : `+${idle.length}`}
                    </span>
                    <span className="mt-1.5 text-[11px] font-medium text-muted-foreground">{showIdle ? "Hide idle" : "Idle"}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{showIdle ? "Hide idle agents" : `${idle.map((p) => agentOf(p.agentId).name).join(", ")} · no active run`}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <StripButton side="left" show={edges.left} onClick={() => page(-1)} />
        <StripButton side="right" show={edges.right} onClick={() => page(1)} />
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{summary.length ? summary.join(" · ") : "Everyone is idle."}</p>
    </section>
  );
}


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
      <p className="mt-3 px-1 text-[10px] text-muted-foreground">Google Calendar · read-only, through the Studio Head's connector</p>
    </section>
  );
}

export function DayRail({ state, day, onPickDay, onSelectItem }: { state: WeaveState; day: string; onPickDay: (day: string) => void; onSelectItem: (id: string) => void }) {
  return (
    <div className="space-y-6 px-4 py-4">
      <PresenceStrip presence={state.presence} onSelectItem={onSelectItem} />
      <MiniCalendar key={day.slice(0, 7)} selected={day} onPick={onPickDay} marks={(d) => weaveDayMarkers().filter((m) => m.day === d)} />
      <Timebox day={day} onPickDay={onPickDay} />
    </div>
  );
}
