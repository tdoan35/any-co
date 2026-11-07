import type { ComponentType } from "react";
import { Check, CornerDownLeft, Hourglass } from "lucide-react";
import type { StageState } from "@/lib/run-state";
import { cn } from "@/lib/utils";

const NODE: Record<StageState, { cls: string; icon?: ComponentType<{ className?: string }>; word: string; text: string }> = {
  pending: { cls: "bg-background/60 text-muted-foreground ring-foreground/15", word: "Not started", text: "text-muted-foreground" },
  skipped: { cls: "bg-transparent text-muted-foreground/60 ring-0 outline-1 outline-dashed outline-foreground/25", word: "Skipped", text: "text-muted-foreground/70" },
  active: { cls: "bg-run-soft text-run ring-run/50", word: "In progress", text: "text-run" },
  done: { cls: "bg-ok-soft text-ok ring-ok/40", icon: Check, word: "Done", text: "text-muted-foreground" },
  earlier: { cls: "bg-ok-soft/50 text-ok/70 ring-ok/20", icon: Check, word: "Done, earlier pass", text: "text-muted-foreground" },
  bounced: { cls: "bg-warn-soft text-warn ring-warn/50", icon: CornerDownLeft, word: "Sent back", text: "text-warn" },
  waiting: { cls: "bg-warn-soft text-warn ring-warn/60", icon: Hourglass, word: "Waiting on you", text: "text-warn" },
};

/**
 * The loop, drawn: the team's steps left to right, and the review step's way back to the lead underneath.
 * The way back turns amber once it's been used, and names how much rework is left.
 */
export function LoopStepper({ stages, reworkUsed, reworkBudget, leadName }: {
  stages: { label: string; state: StageState; gate?: boolean }[];
  reworkUsed: number; reworkBudget: number; leadName: string;
}) {
  const n = stages.length;
  const inset = `${50 / n}%`;
  const used = reworkUsed > 0;
  const spent = reworkUsed >= reworkBudget;
  return (
    <div className="relative pb-9" role="list" aria-label="Workflow steps">
      {/* The forward path, centre of the first node to centre of the last. */}
      <span aria-hidden className="absolute top-4 h-px bg-foreground/15" style={{ left: inset, right: inset }} />
      <div className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {stages.map((s, i) => {
          const node = NODE[s.state];
          const live = s.state === "active" || s.state === "waiting";
          return (
            <div key={s.label} role="listitem" className="flex min-w-0 flex-col items-center text-center" aria-label={`${s.label}: ${node.word}`}>
              <span className={cn("relative grid size-8 place-items-center ring-1 backdrop-blur", s.gate ? "rotate-45 rounded-lg" : "rounded-full", node.cls)}>
                {live && <span aria-hidden className={cn("absolute inset-0 animate-[dot-pulse_2.2s_ease-out_infinite] ring-2 motion-reduce:hidden", s.gate ? "rounded-lg" : "rounded-full", s.state === "waiting" ? "ring-warn/60" : "ring-run/60")} />}
                <span className={cn("grid place-items-center", s.gate && "-rotate-45")}>
                  {node.icon ? <node.icon className="size-3.5" /> : live ? <span className="size-2 rounded-full bg-current" /> : <span className="text-[11px] font-medium tabular-nums">{i + 1}</span>}
                </span>
              </span>
              <span className="mt-1.5 max-w-full truncate text-xs font-medium">{s.label}</span>
              <span className={cn("max-w-full truncate text-[10px]", node.text)}>{node.word}</span>
            </div>
          );
        })}
      </div>
      {/* The way back: from the review step to the first step, under the row. */}
      <div aria-hidden className={cn("absolute bottom-3 h-4 rounded-b-xl border-x border-b border-dashed", used ? "border-warn/60" : "border-foreground/20")} style={{ left: inset, right: inset }}>
        <span className={cn("absolute -left-[4.5px] -top-1 size-2 rotate-45 border-l border-t", used ? "border-warn/60" : "border-foreground/25")} />
      </div>
      <span className={cn(
        "absolute bottom-0.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-px text-[11px] backdrop-blur",
        used ? "bg-warn-soft font-medium text-warn" : "bg-background/70 text-muted-foreground",
      )}>
        {spent ? `Rework budget spent · ${reworkUsed}/${reworkBudget}` : used ? `Sent back to ${leadName} · rework ${reworkUsed}/${reworkBudget}` : `Review can send it back to ${leadName} · rework budget ${reworkBudget}`}
      </span>
    </div>
  );
}
