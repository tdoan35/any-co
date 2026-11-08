// Project Gantt: every task as a bar on one time axis, grouped by team, with arrows from each board
// card to the cards that waited on it. A card's bar runs from when it was queued to when it finished;
// its runs are the solid segments inside. The slider sets "as of": the chart redraws as the studio
// stood at that moment (cards appear when queued, bars grow as runs happen), and Play replays the build.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Maximize2, Minus, Pause, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Face } from "@/components/weave/parts";
import { runnerOf, type TaskSummary } from "@/lib/work";
import { cn } from "@/lib/utils";

/** Lanes in the order work flows through the studio (the Flow tab's stages); unknown teams go last. */
const LANE_ORDER = ["team-head", "team-greenlight", "team-design", "team-art", "team-audio", "team-eng", "team-qa", "team-marketing", "team-ops"];

const ROW = 26;
const LANE_HEAD = 28;
const LABEL_W = 264;
const AXIS_H = 34;
const MIN_BAR = 3;
const HOUR = 3_600_000;

type Seg = { start: number; end: number };
interface Bar {
  s: TaskSummary;
  id: string;
  start: number; // queued (card) or first run start
  end: number; // done, or "now" while open
  runs: Seg[];
  upstream: string[];
}
type Row = { kind: "lane"; team: TaskSummary["team"]; count: number; y: number } | { kind: "bar"; bar: Bar; y: number };

function barOf(s: TaskSummary, now: number): Bar | undefined {
  const runs = s.loops.map((r) => {
    const start = Date.parse(r.startedAt);
    return { start, end: r.status === "running" ? now : start + r.durationS * 1000 };
  });
  const queued = s.card ? Date.parse(s.card.createdAt) : runs[0]?.start;
  if (queued === undefined || Number.isNaN(queued)) return undefined;
  const lastRun = Math.max(...runs.map((r) => r.end), queued);
  const end = s.column === "done" ? Math.max(lastRun, s.card && s.card.status === "done" ? Date.parse(s.card.updatedAt) : lastRun) : now;
  return { s, id: s.task.id, start: Math.min(queued, ...runs.map((r) => r.start)), end, runs, upstream: s.card?.upstream ?? [] };
}

const tickSteps = [15, 30, 60, 120, 180, 360, 720].map((m) => m * 60_000);
const fmtTick = (t: number, step: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: step < HOUR ? "2-digit" : undefined });
  return d.getHours() === 0 && d.getMinutes() === 0 ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : time;
};
const fmtAsOf = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

export function ProjectGantt({ summaries }: { summaries: TaskSummary[] }) {
  const navigate = useNavigate();
  const scroller = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  const bars = useMemo(() => summaries.map((s) => barOf(s, now)).filter((b): b is Bar => !!b), [summaries, now]);
  const t0 = useMemo(() => Math.min(...bars.map((b) => b.start)), [bars]);
  const t1 = useMemo(() => Math.max(...bars.map((b) => b.end)), [bars]);
  const span = Math.max(t1 - t0, HOUR);

  // Zoom: pixels per hour. Starts at "fit" once the scroller's width is known.
  const [pxPerHour, setPxPerHour] = useState<number>();
  const fit = () => {
    const w = (scroller.current?.clientWidth ?? 900) - LABEL_W - 24;
    setPxPerHour(Math.max(8, (w / span) * HOUR));
  };
  useEffect(() => { if (pxPerHour === undefined) fit(); }); // eslint-disable-line react-hooks/exhaustive-deps
  const pph = pxPerHour ?? 40;
  const x = (t: number) => ((t - t0) / HOUR) * pph;
  const chartW = Math.max(x(t1) + 24, 200);

  // As of: the replay clock. Defaults to the end; Play sweeps it across the whole span in ~20 s.
  const [asOf, setAsOf] = useState(t1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setAsOf(t1); }, [t1]);
  useEffect(() => {
    if (!playing) return;
    const step = span / 400;
    const id = window.setInterval(() => setAsOf((t) => {
      const next = t + step;
      if (next >= t1) { setPlaying(false); return t1; }
      return next;
    }), 50);
    return () => window.clearInterval(id);
  }, [playing, span, t1]);
  // Keep the replay line in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!playing || !el) return;
    const target = LABEL_W + x(asOf) - el.clientWidth / 2;
    if (Math.abs(el.scrollLeft - target) > el.clientWidth / 4) el.scrollLeft = Math.max(0, target);
  }, [asOf, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = asOf >= t1;
  // Hovering a card lights up the cards it waited on and the cards that waited on it.
  const [hover, setHover] = useState<string>();
  const visible = bars.filter((b) => b.start <= asOf);

  // Rows: lanes by team in studio order, bars by start inside each lane.
  const rows: Row[] = [];
  const yOf = new Map<string, number>();
  let y = 0;
  const lanes = new Map<string, Bar[]>();
  for (const b of visible) lanes.set(b.s.team.id, [...(lanes.get(b.s.team.id) ?? []), b]);
  const laneIds = [...lanes.keys()].sort((a, b) => {
    const ia = LANE_ORDER.indexOf(a), ib = LANE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const id of laneIds) {
    const items = lanes.get(id)!.sort((a, b) => a.start - b.start);
    rows.push({ kind: "lane", team: items[0]!.s.team, count: items.length, y });
    y += LANE_HEAD;
    for (const bar of items) {
      rows.push({ kind: "bar", bar, y });
      yOf.set(bar.id, y + ROW / 2);
      y += ROW;
    }
  }
  const height = y;

  // Arrows: from the end of an upstream card to the start of the card that waited on it.
  const byId = new Map(visible.map((b) => [b.id, b]));
  const arrows = visible.flatMap((b) => b.upstream.flatMap((u) => {
    const from = byId.get(u);
    if (!from || !yOf.has(u)) return [];
    const x1 = x(Math.min(from.end, asOf)), y1 = yOf.get(u)!;
    const x2 = x(b.runs[0]?.start ?? b.start), y2 = yOf.get(b.id)!;
    return [{ key: `${u}>${b.id}`, from: u, to: b.id, d: `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2 - 3} ${y2}`, head: { x: x2, y: y2 } }];
  }));
  const hasLinks = bars.some((b) => b.upstream.length > 0);
  const linked = new Set(hover ? arrows.flatMap((a) => (a.from === hover || a.to === hover ? [a.from, a.to] : [])) : []);
  const lit = (a: { from: string; to: string }) => !!hover && (a.from === hover || a.to === hover);

  const step = tickSteps.find((s) => (s / HOUR) * pph >= 72) ?? 1440 * 60_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);

  if (!bars.length) return <p className="m-5 rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">No work to chart yet.</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls: replay slider, play, zoom. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-foreground/10 bg-background/40 px-5 py-2">
        <Button variant="ghost" size="icon-sm" aria-label={playing ? "Pause replay" : "Play the build"} title={playing ? "Pause" : "Replay the build"}
          onClick={() => { if (!playing && asOf >= t1) setAsOf(t0); setPlaying(!playing); }}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <input type="range" aria-label="Show the chart as of" min={t0} max={t1} step={60_000} value={asOf}
          onChange={(e) => { setPlaying(false); setAsOf(Number(e.target.value)); }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-foreground" />
        <span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {live ? <>Now · <span className="text-foreground">{visible.length} cards</span></> : <>As of <span className="font-medium text-foreground">{fmtAsOf(asOf)}</span></>}
        </span>
        <span className="mx-1 h-4 w-px bg-foreground/10" />
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => setPxPerHour(Math.max(4, pph / 1.5))}><Minus /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => setPxPerHour(Math.min(2400, pph * 1.5))}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Fit the whole project" title="Fit" onClick={fit}><Maximize2 /></Button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
        <div className="relative" style={{ width: LABEL_W + chartW }}>
          {/* Time axis, pinned to the top. */}
          <div className="sticky top-0 z-20 flex border-b border-foreground/10 bg-background/80 backdrop-blur" style={{ height: AXIS_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-end border-r border-foreground/10 bg-background/90 px-3 pb-1.5 text-[11px] font-medium text-muted-foreground" style={{ width: LABEL_W }}>
              {visible.length} {visible.length === 1 ? "card" : "cards"}
              <span className="ml-1 font-normal text-muted-foreground/70">{hasLinks ? "· hover a card for its links" : "· links coming"}</span>
            </div>
            <div className="relative" style={{ width: chartW }}>
              {ticks.map((t) => (
                <span key={t} className="absolute bottom-1.5 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground" style={{ left: x(t) }}>{fmtTick(t, step)}</span>
              ))}
            </div>
          </div>

          <div className="flex">
            {/* Labels, pinned to the left. */}
            <div className="sticky left-0 z-10 shrink-0 border-r border-foreground/10 bg-background/85 backdrop-blur" style={{ width: LABEL_W, height }}>
              {rows.map((r) => r.kind === "lane"
                ? (
                  <div key={`lane-${r.team.id}`} className="flex items-center gap-2 border-t border-foreground/10 bg-foreground/[0.03] px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ height: LANE_HEAD }}>
                    {r.team.name}<span className="font-normal tabular-nums">{r.count}</span>
                  </div>
                )
                : (
                  <button key={r.bar.id} type="button" onClick={() => navigate(`/work/${r.bar.id}`)} title={r.bar.s.task.title}
                    onMouseEnter={() => setHover(r.bar.id)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(r.bar.id)} onBlur={() => setHover(undefined)}
                    className={cn("flex w-full items-center gap-2 px-3 text-left text-xs outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5",
                      hover && hover !== r.bar.id && linked.has(r.bar.id) && "bg-foreground/[0.07] font-medium")} style={{ height: ROW }}>
                    <Face id={(r.bar.s.loops.length === 0 && r.bar.s.card?.assignee) || runnerOf(r.bar.s.team, r.bar.s.loops.at(-1))} size="size-4" />
                    <span className="min-w-0 flex-1 truncate">{r.bar.s.task.title}</span>
                  </button>
                ))}
            </div>

            {/* Chart. */}
            <div className="relative" style={{ width: chartW, height }}>
              {ticks.map((t) => <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-foreground/[0.06]" style={{ left: x(t) }} />)}
              {rows.filter((r) => r.kind === "lane").map((r) => (
                <span key={`band-${r.kind === "lane" ? r.team.id : ""}`} aria-hidden className="absolute inset-x-0 border-t border-foreground/10 bg-foreground/[0.03]" style={{ top: r.y, height: LANE_HEAD }} />
              ))}

              {rows.map((r) => {
                if (r.kind !== "bar") return null;
                const b = r.bar;
                const end = Math.min(b.end, asOf);
                const doneNow = b.s.column === "done" && b.end <= asOf;
                const blocked = live && b.s.card?.status === "blocked";
                const running = b.runs.some((s) => s.start <= asOf && asOf < s.end);
                return (
                  <button key={b.id} type="button" onClick={() => navigate(`/work/${b.id}`)}
                    onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(undefined)} onFocus={() => setHover(b.id)} onBlur={() => setHover(undefined)}
                    title={`${b.s.task.title}\n${b.runs.length} ${b.runs.length === 1 ? "run" : "runs"} · ${fmtAsOf(b.start)} → ${b.end >= now - 1000 && b.s.column !== "done" ? "open" : fmtAsOf(b.end)}`}
                    aria-label={b.s.task.title}
                    className={cn(
                      "absolute rounded-[4px] border outline-none transition-[width] focus-visible:ring-2 focus-visible:ring-ring",
                      doneNow ? "border-ok/30 bg-ok/10" : blocked ? "border-warn/50 bg-warn-soft" : "border-foreground/15 bg-foreground/[0.06]",
                      (hover === b.id || linked.has(b.id)) && "z-10 ring-2 ring-foreground/50",
                    )}
                    style={{ left: x(b.start), width: Math.max(MIN_BAR, x(end) - x(b.start)), top: r.y + 5, height: ROW - 10 }}>
                    {b.runs.filter((s) => s.start <= asOf).map((s, i) => (
                      <span key={i} aria-hidden
                        className={cn("absolute inset-y-0 rounded-[3px]", doneNow ? "bg-ok/70" : running && s.end > asOf ? "animate-pulse bg-run" : "bg-run/80")}
                        style={{ left: x(s.start) - x(b.start), width: Math.max(2, x(Math.min(s.end, asOf)) - x(s.start)) }} />
                    ))}
                  </button>
                );
              })}

              {arrows.length > 0 && (
                <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={chartW} height={height}
                  fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
                  {/* Unlit first, lit last, so the hovered card's links draw on top. */}
                  {[...arrows].sort((a, b) => Number(lit(a)) - Number(lit(b))).map((a) => (
                    <g key={a.key} className={cn("transition-colors", lit(a) ? "text-foreground/80" : hover ? "text-foreground/[0.07]" : "text-foreground/[0.16]")} strokeWidth={lit(a) ? 1.75 : 1.25}>
                      <path d={a.d} />
                      <path d={`M ${a.head.x - 7} ${a.head.y - 3.5} L ${a.head.x - 2} ${a.head.y} L ${a.head.x - 7} ${a.head.y + 3.5}`} />
                    </g>
                  ))}
                </svg>
              )}

              {/* The replay line. */}
              {!live && <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: x(asOf) }} />}
            </div>
          </div>
        </div>
      </div>

      {/* Legend. */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-t border-foreground/10 bg-background/40 px-5 py-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-sm border border-foreground/15 bg-foreground/[0.06]" />queued or waiting</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-sm bg-run/80" />agent run</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-sm bg-ok/70" />done</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-5 rounded-sm border border-warn/50 bg-warn-soft" />blocked</span>
        <span className="flex items-center gap-1.5"><svg width="20" height="8" aria-hidden className="text-foreground/40"><path d="M1 4 H17 M14 1 L18 4 L14 7" fill="none" stroke="currentColor" strokeWidth="1.25" /></svg>waited on</span>
      </div>
    </div>
  );
}
