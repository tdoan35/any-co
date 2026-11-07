import { Link } from "react-router";
import { FileText, MessageCircle, Play, SquareKanban } from "lucide-react";
import type { Occurrence, Schedule } from "@fabric/contracts";
import { describeRecurrence } from "@fabric/contracts";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Face } from "@/components/weave/parts";
import { cn } from "@/lib/utils";
import { fmtTime, localTz } from "@/lib/schedule";

/** The state pill every surface agrees on: a word plus a tint, never colour alone. */
const STATE: Record<Occurrence["state"], string> = {
  upcoming: "bg-foreground/5 text-muted-foreground",
  running: "bg-run-soft text-run",
  accepted: "bg-ok-soft text-ok",
  posted: "bg-ok-soft text-ok",
  blocked: "bg-warn-soft text-warn",
  stopped: "bg-foreground/5 text-muted-foreground",
  skipped: "bg-foreground/5 text-muted-foreground",
  missed: "bg-foreground/5 text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

export function OccurrenceSheet({ occurrence, schedule, onClose, onRunNow, onSkip, onEdit, onToggleEnabled, busy }: {
  occurrence: Occurrence | null;
  schedule: Schedule | undefined;
  onClose: () => void;
  onRunNow: () => void;
  onSkip: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  busy: boolean;
}) {
  return (
    <Sheet open={!!occurrence} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[22rem] sm:max-w-[22rem]">
        {occurrence && schedule && (
          <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 text-left">
                <Face id={occurrence.agentId} size="size-8" />
                <span className="min-w-0 flex-1 truncate">{occurrence.title}</span>
                <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium capitalize", STATE[occurrence.state])}>{occurrence.state}</span>
              </SheetTitle>
              <SheetDescription>
                {fmtTime(occurrence.at)} – {fmtTime(occurrence.end)} · {localTz}
              </SheetDescription>
            </SheetHeader>

            <p className="text-sm text-muted-foreground">{schedule.prompt}</p>

            <div className="grid gap-1 text-xs text-muted-foreground">
              <span>{describeRecurrence(schedule.recurrence)} · {schedule.tz}</span>
              <span>{schedule.kind === "team" ? "Team routine — lands on Work with a report" : "Dana routine — posts into this thread"}</span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {occurrence.taskId && (
                <Link to={`/work/${occurrence.taskId}`} className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground">
                  <SquareKanban className="size-3" />Task
                </Link>
              )}
              {occurrence.runId && (
                <Link to={`/runs/${occurrence.runId}`} className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground">
                  <Play className="size-3" />Loop
                </Link>
              )}
              {occurrence.reportId && (
                <Link to={`/reports/${occurrence.reportId}`} className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground">
                  <FileText className="size-3" />Report
                </Link>
              )}
              {occurrence.sessionId && (
                <Link to={`/?session=${encodeURIComponent(occurrence.sessionId)}`} className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground">
                  <MessageCircle className="size-3" />Thread
                </Link>
              )}
            </div>

            <Separator />

            <div className="mt-auto grid gap-2">
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" disabled={busy} onClick={onRunNow}>Run now</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={onSkip}>Skip this one</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="ghost" onClick={onEdit}>Edit routine</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleEnabled}>
                  {schedule.enabled ? "Pause" : "Resume"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
