import type { ComponentType, ReactNode } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, CircleDot, CirclePause, Hourglass, Sparkles, Square } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Face, agentOf } from "@/components/weave/parts";
import type { InboxItem } from "@/lib/mock/weave";
import type { StageState } from "@/lib/run-state";
import type { LoopState } from "@/lib/work";
import { cn } from "@/lib/utils";

/** The glass card every Work surface uses (same recipe as Weave's). */
export const card = "rounded-xl border border-foreground/10 bg-background/70 shadow-sm backdrop-blur-md";

/** Status always carries an icon and a word, never colour alone. */
const STATE: Record<LoopState, { label: string; icon: ComponentType<{ className?: string }>; cls: string }> = {
  proposed: { label: "Proposed", icon: Sparkles, cls: "bg-replay-soft text-replay" },
  running: { label: "Running", icon: CircleDot, cls: "bg-run-soft text-run" },
  review: { label: "In review", icon: CircleDot, cls: "bg-run-soft text-run" },
  blocked: { label: "Blocked", icon: CirclePause, cls: "bg-warn-soft text-warn" },
  accepted: { label: "Accepted", icon: Check, cls: "bg-ok-soft text-ok" },
  caveat: { label: "Accepted · caveat", icon: Check, cls: "bg-ok-soft text-ok" },
  stopped: { label: "Stopped", icon: Square, cls: "bg-foreground/5 text-muted-foreground" },
};

export function StatePill({ state, className }: { state: LoopState; className?: string }) {
  const s = STATE[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium", s.cls, className)}>
      <s.icon className="size-3" />{s.label}
    </span>
  );
}

const DOT: Record<StageState, string> = {
  pending: "bg-foreground/12",
  skipped: "bg-foreground/5 ring-1 ring-inset ring-foreground/15",
  earlier: "bg-ok/35",
  done: "bg-ok",
  active: "bg-run",
  waiting: "bg-warn",
  bounced: "bg-warn",
};
const STAGE_WORD: Record<StageState, string> = {
  pending: "not started", skipped: "skipped", earlier: "done in an earlier pass", done: "done", active: "in progress", waiting: "waiting on you", bounced: "sent back",
};

/** The team's workflow as a row of dots; the review step is a diamond. */
export function StepDots({ stages, className }: { stages: { label: string; state: StageState; gate?: boolean }[]; className?: string }) {
  return (
    <span role="img" className={cn("flex items-center gap-1", className)} aria-label={stages.map((s) => `${s.label}: ${STAGE_WORD[s.state]}`).join(", ")}>
      {stages.map((s) => (
        <Tooltip key={s.label}>
          <TooltipTrigger asChild>
            <span className={cn("relative block size-2 shrink-0", s.gate ? "rotate-45 rounded-[1px]" : "rounded-full", DOT[s.state])}>
              {(s.state === "active" || s.state === "waiting") && (
                <span aria-hidden className={cn("absolute inset-0 animate-[dot-pulse_2.2s_ease-out_infinite] motion-reduce:hidden", s.gate ? "rounded-[1px]" : "rounded-full", DOT[s.state])} />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{s.label} · {STAGE_WORD[s.state]}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

/** Amber, never red: what's waiting on you, with a jump to it in Weave. */
export function AskFlag({ asks, proposal, className }: { asks: InboxItem[]; proposal?: InboxItem; className?: string }) {
  const navigate = useNavigate();
  const first = asks[0] ?? proposal;
  if (!first) return null;
  const label = asks.length
    ? asks.length === 1 ? (asks[0].kind === "escalation" ? "Escalated to you" : "1 ask waiting on you") : `${asks.length} asks waiting on you`
    : "Waiting for your yes";
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); navigate(`/weave?item=${first.id}`); }}
      title={asks.map((a) => a.title).join("\n") || proposal?.title}
      className={cn("relative z-10 inline-flex max-w-full items-center gap-1.5 rounded-md border border-warn/30 bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn transition-colors hover:border-warn/60", className)}
    >
      <Hourglass className="size-3 shrink-0" /><span className="truncate">{label}</span><ArrowRight className="size-3 shrink-0" />
    </button>
  );
}

/** A ratio against a limit. The track is a lighter step of the fill's own hue. */
export function Meter({ value, max, tone = "run", label, className }: { value: number; max: number; tone?: "run" | "ok" | "warn"; label?: string; className?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  const track = { run: "bg-run-soft", ok: "bg-ok-soft", warn: "bg-warn-soft" }[tone];
  const fill = { run: "bg-run", ok: "bg-ok", warn: "bg-warn" }[tone];
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full", track, className)} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span className={cn("block h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Rework as pips: used ones amber. */
export function ReworkPips({ used, budget }: { used: number; budget: number }) {
  return (
    <span role="img" className="flex gap-0.5" aria-label={`Rework ${used} of ${budget} used`}>
      {Array.from({ length: budget }, (_, i) => <span key={i} className={cn("h-1.5 w-3 rounded-full", i < used ? "bg-warn" : "bg-foreground/12")} />)}
    </span>
  );
}

export function FaceStack({ ids, size = "size-6", ring }: { ids: string[]; size?: string; ring?: "run" | "warn" }) {
  return (
    <span className="flex -space-x-1.5">
      {ids.map((id) => (
        <span key={id} title={`${agentOf(id).name} · ${agentOf(id).role}`} className={cn("relative flex shrink-0 rounded-full ring-2 ring-background", ring === "run" && "ring-run/60", ring === "warn" && "ring-warn/70")}>
          <Face id={id} size={size} />
        </span>
      ))}
    </span>
  );
}

/** Small uppercase-free section label used across Work. */
export function Label({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs font-medium text-muted-foreground", className)}>
      {children}
      {right && <span className="ml-auto font-normal">{right}</span>}
    </div>
  );
}
