import { FastForward, Pause, Play, Radio, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtClock, type RunMarker } from "@/lib/run-state";
import { SPEEDS, type ClockStart, type RunClock } from "@/lib/use-run-clock";
import { cn } from "@/lib/utils";

const MARK: Record<RunMarker["kind"], string> = {
  bounce: "size-2.5 rotate-45 rounded-[2px] bg-warn ring-2 ring-background",
  accept: "size-2.5 rotate-45 rounded-[2px] bg-ok ring-2 ring-background",
  blocked: "size-2.5 rotate-45 rounded-[2px] bg-warn ring-2 ring-background",
  artifact: "size-1.5 rounded-full bg-foreground/45",
  denied: "h-2.5 w-0.5 rounded-full bg-warn",
};

/** Live / Replay · N×. Replay is always badged ("Was this real?"). */
export function ClockBadge({ clock, start, liveActive = true }: { clock: RunClock; start: ClockStart; liveActive?: boolean }) {
  return clock.source === "live" && liveActive
    ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-run-soft px-2 py-0.5 text-xs font-medium text-run" title={start === "sim" ? "Simulated from the recorded loop" : "Where the loop is now"}>
        <span className="size-1.5 animate-pulse rounded-full bg-run" />Live{start === "now" && " · now"}
      </span>
    )
    : <span className="inline-flex items-center rounded-full bg-replay-soft px-2 py-0.5 text-xs font-medium text-replay">Replay · {clock.speed}×</span>;
}

/**
 * Play, scrub, speed. Markers on the track are the moments worth jumping to: verdicts (diamonds),
 * artifacts (dots) and blocked tool calls (ticks). Fast-forward runs at 600× and pauses on each verdict.
 */
export function Transport({ clock, max, markers, start }: { clock: RunClock; max: number; markers: RunMarker[]; start: ClockStart }) {
  const pct = (s: number) => `${max > 0 ? (s / max) * 100 : 0}%`;
  const atNow = start === "now" && clock.source === "live";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-foreground/10 px-3 py-2.5">
      <Button size="icon-sm" variant="ghost" onClick={() => clock.play(!clock.playing)} aria-label={clock.playing ? "Pause" : "Play"}>
        {clock.playing ? <Pause /> : <Play />}
      </Button>
      <div className="relative h-6 min-w-40 flex-1">
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/10" />
        <span className={cn("absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full", clock.source === "live" ? "bg-run" : "bg-replay")} style={{ width: pct(clock.t) }} />
        <input
          type="range" min={0} max={max} step={1} value={clock.t}
          onChange={(e) => clock.scrub(Number(e.target.value))}
          aria-label="Scrub the loop" aria-valuetext={fmtClock(clock.t)}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
        />
        {markers.map((mk) => (
          <Tooltip key={`${mk.kind}-${mk.t}-${mk.label}`}>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => clock.scrub(mk.t)} aria-label={`${mk.label} at ${fmtClock(mk.t)}`}
                className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center" style={{ left: pct(mk.t) }}>
                <span className={MARK[mk.kind]} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{mk.label} · {fmtClock(mk.t)}</TooltipContent>
          </Tooltip>
        ))}
        <span className={cn("pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background", clock.source === "live" ? "bg-run" : "bg-replay")} style={{ left: pct(clock.t) }} />
      </div>
      <span className="w-[7.5rem] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{fmtClock(clock.t)} / {fmtClock(max)}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex rounded-md border border-foreground/10 text-xs" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" onClick={() => clock.changeSpeed(s)} aria-pressed={clock.speed === s}
              className={cn("px-2 py-1 tabular-nums first:rounded-l-md last:rounded-r-md", clock.speed === s ? "bg-foreground text-background" : "text-muted-foreground hover:bg-foreground/5")}>{s}×</button>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" className="bg-background/60" onClick={clock.fastForward}><FastForward />Fast-forward</Button>
          </TooltipTrigger>
          <TooltipContent side="top">600×, pausing on each verdict · <kbd className="font-mono">R</kbd></TooltipContent>
        </Tooltip>
        {start === "now"
          ? <Button size="sm" variant={atNow ? "ghost" : "outline"} disabled={atNow} className="bg-background/60" onClick={clock.goLive}><Radio />Go live</Button>
          : (
            <Tooltip>
              <TooltipTrigger asChild><Button size="icon-sm" variant="ghost" onClick={clock.restart} aria-label="Restart"><RotateCcw /></Button></TooltipTrigger>
              <TooltipContent side="top">Restart</TooltipContent>
            </Tooltip>
          )}
      </div>
    </div>
  );
}
