import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Face, agentOf } from "@/components/weave/parts";
import type { StudioTeam } from "@/lib/mock/teams";
import { fmtClock, fmtSpan, isActive, type MemberState, type RunView } from "@/lib/run-state";
import type { Run, RunSegment } from "@/lib/types";
import { addSeconds, leadOf, when } from "@/lib/work";
import { cn } from "@/lib/utils";

const ROW = 52;
const LABEL_W = 188;

const STATE: Record<MemberState, { word: string; cls: string }> = {
  idle: { word: "Idle", cls: "text-muted-foreground" },
  working: { word: "Working", cls: "text-run" },
  rework: { word: "Reworking", cls: "text-run" },
  done: { word: "Done", cls: "text-muted-foreground" },
  bounced: { word: "Sent it back", cls: "text-warn" },
  waiting: { word: "Waiting on you", cls: "text-warn" },
  blocked: { word: "Blocked", cls: "text-muted-foreground" },
};

/** Status colours, each paired with the segment's own label. Live segments are blue, finished ones green. */
function segClass(s: RunSegment, live: boolean) {
  if (s.kind === "bounce") return "bg-warn-soft text-warn border-warn/40";
  if (s.kind === "blocked") return "bg-foreground/5 text-muted-foreground border-foreground/20 border-dashed";
  if (s.kind === "wait") return "bg-warn-soft/60 text-warn border-warn/50 border-dashed bg-[repeating-linear-gradient(135deg,transparent_0_5px,color-mix(in_oklab,var(--warn)_12%,transparent)_5px_7px)]";
  const tone = live ? "bg-run-soft text-run border-run/40" : "bg-ok-soft text-ok border-ok/30";
  return cn(tone, s.kind === "rework" && "border-dashed");
}

const LEGEND = [
  { label: "Working", cls: "bg-run-soft border-run/40" },
  { label: "Done", cls: "bg-ok-soft border-ok/30" },
  { label: "Rework", cls: "bg-ok-soft border-ok/40 border-dashed" },
  { label: "Sent back", cls: "bg-warn-soft border-warn/40" },
  { label: "Waiting on you", cls: "bg-warn-soft/60 border-warn/50 border-dashed" },
  { label: "Blocked", cls: "bg-foreground/5 border-foreground/20 border-dashed" },
];

const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
/** Tick spacing that gives about five labels across the domain. */
function ticks(domain: number) {
  const step = STEPS.find((s) => domain / s <= 6) ?? 7200;
  return Array.from({ length: Math.floor(domain / step) + 1 }, (_, i) => i * step);
}
const tickLabel = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : s % 3600 ? `${Math.floor(s / 3600)}h ${(s % 3600) / 60}m` : `${s / 3600}h`);


export function LanesLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {LEGEND.map((l) => <li key={l.label} className="flex items-center gap-1.5"><span className={cn("h-2.5 w-4 rounded-[3px] border", l.cls)} />{l.label}</li>)}
    </ul>
  );
}

export function Lanes({ run, team, view, t, domain, selected, onSelect }: {
  run: Run; team: StudioTeam; view: RunView; t: number; domain: number; selected?: string; onSelect: (id: string) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const D = domain;
  const pct = (s: number) => `${(Math.min(s, D) / D) * 100}%`;
  const ongoing = (run.status === "running" || run.status === "blocked") && !run.recording;
  const lead = leadOf(team);
  const rows = team.members.map((m) => m.agentId);
  const rowOf = (id: string) => rows.indexOf(id);

  // The reviewer's bounce, drawn as an arrow back to the lead's next step.
  const arrows = run.segments
    .filter((s) => s.kind === "bounce" && s.end <= t)
    .map((b) => {
      const next = run.segments.filter((s) => s.agentId === lead && s.start >= b.end - 60).sort((a, c) => a.start - c.start)[0];
      return next && next.start <= t ? { from: b, to: next } : undefined;
    })
    .filter((a): a is { from: RunSegment; to: RunSegment } => !!a);

  return (
    <div>
      <div className="flex border-b border-foreground/10 text-[11px] text-muted-foreground">
        <div className="shrink-0 px-4 py-2" style={{ width: LABEL_W }}>Who</div>
        <div className="relative h-8 flex-1">
          {ticks(D).map((k, i, all) => (
            <span key={k} className={cn("absolute top-2 tabular-nums", i === 0 ? "translate-x-0" : i === all.length - 1 && k / D > 0.94 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: pct(k) }}>{tickLabel(k)}</span>
          ))}
          {run.etaS && <span className="absolute right-2 top-2 rounded bg-background/80 px-1 text-run">ETA {when(addSeconds(run.startedAt, run.etaS))}</span>}
        </div>
      </div>
      <div className="relative">
        {view.members.map((m) => {
          const a = agentOf(m.agentId);
          const st = STATE[m.state];
          const segs = run.segments.filter((s) => s.agentId === m.agentId && s.start <= t);
          return (
            <button
              key={m.agentId}
              type="button"
              onClick={() => onSelect(m.agentId)}
              aria-pressed={selected === m.agentId}
              className={cn("flex w-full border-b border-foreground/10 text-left outline-none transition-colors last:border-b-0 hover:bg-foreground/[0.03] focus-visible:bg-foreground/5", selected === m.agentId && "bg-foreground/[0.06] hover:bg-foreground/[0.06]")}
              style={{ height: ROW }}
            >
              <div className="flex shrink-0 items-center gap-2.5 px-3" style={{ width: LABEL_W }}>
                <span className={cn("flex shrink-0 rounded-full ring-2 ring-offset-1 ring-offset-transparent", m.state === "working" || m.state === "rework" ? "ring-run/60" : m.state === "waiting" || m.state === "bounced" ? "ring-warn/60" : "ring-transparent")}>
                  <Face id={m.agentId} size="size-7" />
                </span>
                <span className="min-w-0 text-xs leading-tight">
                  <span className="block truncate"><span className="font-medium">{a.name}</span> <span className="text-muted-foreground">· {a.role}</span></span>
                  <span className={cn("block truncate text-[11px]", st.cls)}>
                    {/* Waiting and blocked segments already say why; working ones name the step. */}
                    {m.state === "waiting" || m.state === "blocked" ? m.currentLabel : m.currentLabel && m.state !== "idle" && m.state !== "done" ? `${st.word} · ${m.currentLabel}` : st.word}
                  </span>
                </span>
              </div>
              <div ref={m.agentId === rows[0] ? areaRef : undefined} className="relative flex-1">
                {segs.map((s, i) => {
                  const live = isActive(run, s, t) && s.kind !== "bounce" && s.kind !== "blocked";
                  const end = live ? t : Math.min(s.end, t);
                  // Too narrow for its label: put the label beside it, right if there's room before the next segment, else left.
                  const px = (v: number) => (Math.min(v, D) / D) * width;
                  const labelW = s.label.length * 6.2 + 18; // text plus the pill's padding and border
                  const outside = width > 0 && px(end) - px(s.start) < labelW;
                  const nextStart = segs[i + 1] ? px(segs[i + 1].start) : width;
                  const prevEnd = i > 0 ? px(Math.min(segs[i - 1].end, t)) : 0;
                  const side = !outside ? undefined : px(end) + 4 + labelW <= nextStart ? "right" : px(s.start) - 4 - labelW >= prevEnd ? "left" : undefined;
                  return (
                    <Tooltip key={`${s.label}-${s.start}`}>
                      <TooltipTrigger asChild>
                        <span
                          className={cn("absolute top-1/2 flex h-6 -translate-y-1/2 items-center whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium transition-[left,width] duration-150 ease-linear", !side && "overflow-hidden", segClass(s, live))}
                          style={{ left: pct(s.start), width: `max(${pct(end - s.start)}, 6px)`, maxWidth: `calc(100% - ${pct(s.start)})` }}
                        >
                          {side
                            ? <span className={cn("absolute", side === "right" ? "left-full ml-1.5" : "right-full mr-1.5")}>{s.label}</span>
                            : !outside && <span className="truncate">{s.label}</span>}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="font-medium">{a.name} · {s.label}</div>
                        <div className="opacity-80">{s.stage} step · {fmtClock(s.start)}–{live ? "now" : fmtClock(s.end)} ({fmtSpan(end - s.start)})</div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </button>
          );
        })}
        {/* Overlays share the timeline's coordinates: everything right of the label column. */}
        <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
          {ongoing && run.durationS < D && (
            <span className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_oklab,var(--foreground)_5%,transparent)_6px_7px)]" style={{ left: pct(run.durationS) }} />
          )}
          {ongoing && (
            <span className="absolute inset-y-0 w-px bg-warn" style={{ left: pct(run.durationS) }}>
              <span className={cn("absolute -top-px -translate-y-full rounded bg-warn px-1 text-[10px] font-medium leading-4 text-background", run.durationS / D > 0.96 ? "right-0" : "left-1/2 -translate-x-1/2")}>Now</span>
            </span>
          )}
          {(!ongoing || t < run.durationS) && t < D && (
            <span className="absolute inset-y-0 w-px bg-replay transition-[left] duration-150 ease-linear" style={{ left: pct(t) }} />
          )}
          {width > 0 && arrows.length > 0 && (
            <svg className="absolute inset-0 overflow-visible" width={width} height={rows.length * ROW} aria-hidden>
              <defs>
                <marker id="bounce-head" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L8 4 L0 8 z" className="fill-warn" />
                </marker>
              </defs>
              {arrows.map(({ from, to }) => {
                const x1 = (Math.min(from.end, D) / D) * width, y1 = rowOf(from.agentId) * ROW + ROW / 2 - 13;
                const x2 = (Math.min(to.start, D) / D) * width + 2, y2 = rowOf(to.agentId) * ROW + ROW / 2 + 13;
                const bulge = 26;
                return (
                  <path key={from.start} d={`M ${x1} ${y1} C ${x1 + bulge} ${y1 - 30}, ${x2 + bulge} ${y2 + 30}, ${x2} ${y2}`}
                    className="fill-none stroke-warn" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#bounce-head)" />
                );
              })}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
