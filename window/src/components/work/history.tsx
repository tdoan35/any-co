import { Link } from "react-router";
import { Play } from "lucide-react";
import { Face } from "@/components/weave/parts";
import type { Project } from "@/lib/mock/sessions";
import { fmtSpan } from "@/lib/run-state";
import { leadOf, reworkOf, when, type PreviousLoop } from "@/lib/work";
import { cn } from "@/lib/utils";
import { Label, StatePill, card } from "./parts";

/** Finished loops as a ledger. Each row replays its loop. */
export function PreviousLoops({ loops, projects, lens }: { loops: PreviousLoop[]; projects: Project[]; lens: "project" | "team" }) {
  return (
    <section>
      <Label right={<span className="tabular-nums">{loops.length}</span>} className="mb-2 px-1">Previous loops</Label>
      {loops.length === 0
        ? <p className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">Nothing has finished yet. Finished loops land here, ready to replay.</p>
        : (
          <ul className={cn(card, "divide-y divide-foreground/10")}>
            {loops.map(({ run, summary, outcome, endedAt }) => (
              <li key={run.id}>
                <Link
                  to={`/work/${summary.task.id}${run === summary.latest ? "" : `?loop=${run.n}`}`}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-foreground/5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto]"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Face id={leadOf(summary.team)} size="size-6" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{summary.task.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Loop {run.n}{run.recorded && " · recorded"} · {lens === "project" ? summary.team.name : projects.find((p) => p.id === summary.task.projectId)?.name}
                      </span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
                    {fmtSpan(run.durationS)} · rework {reworkOf(run)}/{run.reworkBudget}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatePill state={outcome} />
                    <span className="hidden w-12 text-right text-xs tabular-nums text-muted-foreground sm:inline">{when(endedAt)}</span>
                  </span>
                  <span className="hidden items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground md:flex">
                    <Play className="size-3" />Replay
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
