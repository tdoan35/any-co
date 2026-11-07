import { useMemo, useState } from "react";
import { Cron } from "croner";
import { ChevronDown } from "lucide-react";
import type { Recurrence, Schedule, ScheduleInput } from "@fabric/contracts";
import { describeRecurrence, toCron } from "@fabric/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/studio/studio-ui";
import { Face } from "@/components/weave/parts";
import { cn } from "@/lib/utils";
import { projects, studioTeams, useRegistry } from "@/lib/registry";
import { localTz } from "@/lib/schedule";

const FREQS = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** What the editor starts from: an existing routine, or a click on an empty slot. */
export interface EditorTarget {
  schedule?: Schedule;
  /** "YYYY-MM-DD" from the slot (or today); drives once/monthly defaults and the time prefill. */
  day?: string;
  time?: string;
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function ScheduleEditor({ target, open, onOpenChange, onSave, onDelete }: {
  target: EditorTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: ScheduleInput & { enabled?: boolean }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  useRegistry();
  const existing = target.schedule;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [who, setWho] = useState(existing?.kind === "team" ? `team:${existing.teamId}` : "dana");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [projectId, setProjectId] = useState(existing?.projectId ?? "");
  const [freq, setFreq] = useState<Recurrence["freq"]>(existing?.recurrence.freq ?? "weekly");
  const [days, setDays] = useState<number[]>(existing?.recurrence.days ?? [1, 2, 3, 4, 5]);
  const [date, setDate] = useState(existing?.recurrence.date ?? target.day ?? "");
  const [time, setTime] = useState(existing?.recurrence.time ?? target.time ?? hhmm(9 * 60));
  const [duration, setDuration] = useState(String(existing?.durationMin ?? 30));
  const [saving, setSaving] = useState(false);

  const teamId = who.startsWith("team:") ? who.slice(5) : undefined;
  const recurrence: Recurrence = {
    freq,
    time,
    ...(freq === "weekly" ? { days } : {}),
    ...(freq === "once" || freq === "monthly" ? { date: date || undefined } : {}),
  };

  const next = useMemo(() => {
    try {
      const run = new Cron(toCron(recurrence), { timezone: existing?.tz ?? localTz }).nextRun();
      return run ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(run) : undefined;
    } catch {
      return undefined;
    }
  }, [freq, time, days, date, existing?.tz]);

  const valid = title.trim() && prompt.trim() && (freq !== "weekly" || days.length > 0) && (freq !== "once" && freq !== "monthly" || !!date);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        kind: teamId ? "team" : "assistant",
        teamId,
        projectId: teamId ? (projectId || undefined) : undefined,
        prompt: prompt.trim(),
        recurrence,
        tz: existing?.tz ?? localTz,
        durationMin: Number(duration) || 30,
      });
      onOpenChange(false);
    } catch {
      // A failed save keeps the editor open for retry; `finally` releases the button.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit routine" : "New routine"}</DialogTitle>
            <DialogDescription>
              {existing ? "Changing the pattern only affects future occurrences; the past stays as it ran." : "Who runs what, and when. Dana posts results in the routine's own thread."}
            </DialogDescription>
          </DialogHeader>

          <label className="grid gap-1.5 text-xs font-medium">
            Title
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning digest" />
          </label>

          <div className="grid gap-1.5 text-xs font-medium">
            Who
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex h-9 items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-sm font-normal text-left backdrop-blur hover:bg-background/90">
                  {who === "dana" ? <Face id="dana" size="size-5" /> : <Face id={studioTeams().find((t) => t.id === teamId)?.members.find((m) => m.lead)?.agentId ?? "dana"} size="size-5" />}
                  <span className="flex-1">{who === "dana" ? "Dana · one assistant turn" : `${studioTeams().find((t) => t.id === teamId)?.name} · a team run`}</span>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                <DropdownMenuRadioGroup value={who} onValueChange={setWho}>
                  <DropdownMenuRadioItem value="dana">Dana · one assistant turn</DropdownMenuRadioItem>
                  {studioTeams().map((t) => (
                    <DropdownMenuRadioItem key={t.id} value={`team:${t.id}`}>{t.name} · a team run</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <label className="grid gap-1.5 text-xs font-medium">
            Instructions
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder={teamId ? "The objective the team runs with. Criteria come from the team." : "What Dana should cover in this routine."}
              className="field-sizing-content min-h-20 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm font-normal shadow-xs backdrop-blur outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          {teamId && (
            <div className="grid gap-1.5 text-xs font-medium">
              Project
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="flex h-9 items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-sm font-normal text-left backdrop-blur hover:bg-background/90">
                    <span className="flex-1">{projects().find((p) => p.id === projectId)?.name ?? "Routines (default)"}</span>
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                  <DropdownMenuRadioGroup value={projectId} onValueChange={setProjectId}>
                    <DropdownMenuRadioItem value="">Routines (default)</DropdownMenuRadioItem>
                    {projects().filter((p) => !p.archived).map((p) => (
                      <DropdownMenuRadioItem key={p.id} value={p.id}>{p.name}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          <div className="grid gap-1.5 text-xs font-medium">
            Repeat
            <Segmented value={freq} options={FREQS} onChange={setFreq} />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {freq === "weekly" && (
              <div className="flex items-center gap-1" role="group" aria-label="Days of week">
                {DAYS.map((label, day) => (
                  <button
                    key={day} type="button" aria-pressed={days.includes(day)} aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}
                    onClick={() => setDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b))}
                    className={cn(
                      "size-8 rounded-full text-xs font-medium transition-colors",
                      days.includes(day) ? "bg-foreground text-background" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {(freq === "once" || freq === "monthly") && (
              <label className="grid gap-1.5 text-xs font-medium">
                {freq === "once" ? "Date" : "Day of month (from this date)"}
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
              </label>
            )}
            <label className="grid gap-1.5 text-xs font-medium">
              Time
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Duration
              <Input type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} className="w-24" />
            </label>
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {describeRecurrence(recurrence)}{next ? ` · next ${next}` : ""} · {existing?.tz ?? localTz}
            </span>
            <span className="flex gap-2">
              {existing && onDelete && (
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { void onDelete(); onOpenChange(false); }}>Delete</Button>
              )}
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!valid || saving}>{existing ? "Save" : "Create"}</Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
