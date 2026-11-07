import { Link } from "react-router";
import { motion } from "motion/react";
import { FileText, Folder, Repeat2 } from "lucide-react";
import { Face, agentOf } from "@/components/weave/parts";
import type { Project } from "@/lib/mock/sessions";
import { leadOf, loopState, when, type TaskSummary } from "@/lib/work";
import { cn } from "@/lib/utils";
import { AskFlag, FaceStack, StatePill, StepDots, card } from "./parts";


/**
 * One task on the board. The whole card opens it; the ask flag and report link sit above that link.
 * `lens` decides what the corner names: the team (on a project board) or the project (on a team board).
 */
export function TaskCard({ s, lens, project }: { s: TaskSummary; lens: "project" | "team"; project?: Project }) {
  const lead = leadOf(s.team);
  const state = loopState(s);
  const loopCount = s.loops.length;
  const meta: string[] = [];
  if (s.column !== "proposed") meta.push(`rework ${s.reworkUsed}/${s.reworkBudget}`);
  if (s.etaAt && s.column !== "done" && !s.note) meta.push(`ETA ${when(s.etaAt)}`);
  return (
    <motion.article
      layout="position"
      layoutId={`task-${s.task.id}`}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={cn(card, "group relative flex flex-col gap-2.5 p-3.5 transition-colors hover:border-foreground/25 hover:bg-background/85", s.column === "proposed" && "border-dashed")}
    >
      <Link to={`/work/${s.task.id}`} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${s.task.title}`} />
      <div className="flex items-center gap-2 text-xs">
        {lens === "project"
          ? <><Face id={lead} size="size-5" /><span className="min-w-0 truncate font-medium">{s.team.name}</span></>
          : <><Folder className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate text-muted-foreground">{project?.name}</span></>}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {s.endedAt ? when(s.endedAt) : s.startedAt ? when(s.startedAt) : s.task.proposal && when(s.task.proposal.at)}
        </span>
      </div>
      <h3 className="text-[13.5px] font-semibold leading-snug tracking-tight">{s.task.title}</h3>
      {s.column === "proposed"
        ? <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{s.task.proposal?.purpose}</p>
        : (
          <div className="flex items-center gap-2">
            <StepDots stages={s.stages} />
            <span className={cn("min-w-0 truncate text-xs", state === "blocked" ? "text-warn" : "text-muted-foreground")}>
              {s.outcome ? s.stages[s.stages.length - 1].label : s.stage}
            </span>
          </div>
        )}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatePill state={state} />
        {loopCount > 1 && <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-px text-[11px] text-muted-foreground"><Repeat2 className="size-3" />Loop {loopCount}</span>}
        {s.task.preview && <span className="rounded-full bg-foreground/5 px-1.5 py-px text-[11px] text-muted-foreground" title="No Product Team loop is recorded yet, so nothing here can play.">Preview</span>}
        {s.working.length + s.waiting.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            {s.working.length > 0 && <FaceStack ids={s.working} size="size-5" ring="run" />}
            {s.waiting.length > 0 && <FaceStack ids={s.waiting} size="size-5" ring="warn" />}
          </span>
        )}
      </div>
      {(s.note || meta.length > 0 || s.column === "proposed") && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {s.note ?? (s.column === "proposed" ? `Proposed by the Studio Head · ${agentOf(lead).name} would lead` : meta.join(" · "))}
        </p>
      )}
      {(s.asks.length > 0 || s.proposal || s.latest?.reportId) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <AskFlag asks={s.asks} proposal={s.proposal} />
          {s.latest?.reportId && s.outcome?.kind === "accepted" && (
            <Link to={`/reports/${s.latest.reportId}`} className="relative z-10 inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:border-foreground/25">
              <FileText className="size-3" />Report
            </Link>
          )}
        </div>
      )}
    </motion.article>
  );
}
