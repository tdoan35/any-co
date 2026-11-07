import { Link } from "react-router";
import { ArrowRight, SquareKanban } from "lucide-react";
import type { StudioTeam } from "@/lib/mock/teams";
import { useRegistry, workRuns, workTasks } from "@/lib/registry";
import { byUrgency, loopState, summarize, when } from "@/lib/work";
import { useWeave } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { StatePill } from "./parts";

/** A team's tasks with their latest loop, linking into Work. Used by Studio's team card and the chat's team panel. */
export function TeamLoops({ team, rowClassName }: { team: StudioTeam; rowClassName?: string }) {
  const weave = useWeave();
  useRegistry();
  const items = workTasks().filter((t) => t.teamId === team.id).map((t) => summarize(t, workRuns(), weave)).sort(byUrgency);
  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">No loops yet. Ask the Studio Head to hand {team.name} a task.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {items.map((s) => (
          <li key={s.task.id}>
            <Link to={`/work/${s.task.id}`} className={cn("group flex items-center gap-3 rounded-xl border border-foreground/10 bg-background/50 px-3 py-2.5 transition-colors hover:bg-foreground/5", rowClassName)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.task.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {s.loops.length ? `Loop ${s.loops.length} · ${s.stage ?? ""}${s.startedAt ? ` · ${when(s.startedAt)}` : ""}` : "Proposed by the Studio Head"}
                  {s.column !== "proposed" && ` · rework ${s.reworkUsed}/${s.reworkBudget}`}
                </span>
              </span>
              <StatePill state={loopState(s)} />
            </Link>
          </li>
        ))}
      </ul>
      <Link to={`/work?view=teams&team=${team.id}`} className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground">
        <SquareKanban className="size-3.5" />Open {team.name}'s board in Work<ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
