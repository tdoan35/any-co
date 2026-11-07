import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { Occurrence, Schedule, ScheduleInput } from "@fabric/contracts";
import { describeRecurrence } from "@fabric/contracts";
import { PageHeader } from "@/components/shell/app-shell";
import { headerButton, headerTitle } from "@/components/studio/studio-ui";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import type { DayMark } from "@/components/calendar/mini-calendar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Face, agentOf } from "@/components/weave/parts";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import {
  dayKey, fromKey, occKey, parseOccKey, weekBounds, weekRangeLabel, weekStart,
} from "@/lib/schedule";
import { WeekGrid } from "./week-grid";
import { OccurrenceSheet } from "./occurrence-sheet";
import { ScheduleEditor } from "./schedule-editor";
import type { EditorTarget } from "./schedule-editor";

/**
 * Schedule: one week of the agents' routines — past blocks show what ran, dashed blocks what's
 * planned. The right rail holds the month, an agent filter and the routine list. Data is the
 * loader's; every action refetches both lists (mock mode has no SSE to do it for us).
 */
export function SchedulePage({ schedules: loadedSchedules, occurrences: loadedOccurrences, week: loadedWeek, today: todayOverride }: {
  schedules: Schedule[];
  occurrences: Occurrence[];
  week: string;
  /** Story seam: pin "today" (a YYYY-MM-DD key) so stories render the same chrome every run. */
  today?: string;
}) {
  const [params, setParams] = useSearchParams();
  const [schedules, setSchedules] = useState(loadedSchedules);
  const [occurrences, setOccurrences] = useState(loadedOccurrences);
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget }>({ open: false, target: {} });
  const [busy, setBusy] = useState(false);

  // The loader revalidates on SSE (http mode); its fresh data flows in as new props and replaces
  // local state during render.
  const [loaded, setLoaded] = useState({ schedules: loadedSchedules, occurrences: loadedOccurrences });
  if (loaded.schedules !== loadedSchedules || loaded.occurrences !== loadedOccurrences) {
    setLoaded({ schedules: loadedSchedules, occurrences: loadedOccurrences });
    setSchedules(loadedSchedules);
    setOccurrences(loadedOccurrences);
  }

  const bounds = weekBounds(params.get("week") ?? loadedWeek);
  const todayKey = todayOverride ?? dayKey(new Date());
  const refresh = useCallback(async () => {
    const [nextSchedules, nextOccurrences] = await Promise.all([
      api.listSchedules(),
      api.listOccurrences(bounds.from.toISOString(), bounds.to.toISOString()),
    ]);
    setSchedules(nextSchedules);
    setOccurrences(nextOccurrences);
  }, [bounds.from, bounds.to]);

  const setWeek = (sunday: Date) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set("week", dayKey(sunday));
    return next;
  }, { replace: true });
  const shiftWeek = (weeks: number) => {
    const next = new Date(bounds.from);
    next.setDate(next.getDate() + weeks * 7);
    setWeek(next);
  };

  // The mini calendar's selection: today when it's in view, else the week's first day. Key
  // comparison (not instant) so a pinned `today` behaves exactly like the real clock's.
  const todayInRange = bounds.key <= todayKey && todayKey < dayKey(bounds.to);
  const selectedDay = todayInRange ? todayKey : dayKey(bounds.from);
  const pickDay = (key: string) => setWeek(weekStart(fromKey(key)));

  // Days with routines get dots: upcoming or fired, before or after the current week.
  const markedDays = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const o of occurrences) {
      const key = dayKey(new Date(o.at));
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    return byDay;
  }, [occurrences]);
  const marks = useCallback((key: string): DayMark[] =>
    markedDays.has(key) ? [{ label: `${markedDays.get(key)} routine${markedDays.get(key) === 1 ? "" : "s"}`, kind: "activity" }] : [], [markedDays]);

  const visible = occurrences.filter((o) => !hiddenAgents.has(o.agentId));
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of occurrences) counts.set(o.agentId, (counts.get(o.agentId) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [occurrences]);
  const toggleAgent = (id: string) => setHiddenAgents((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const selected = useMemo(() => {
    const key = params.get("occ");
    if (!key) return null;
    const wanted = parseOccKey(key);
    return occurrences.find((o) => occKey(o) === key) ?? (wanted ? occurrences.find((o) => o.scheduleId === wanted.scheduleId && o.at === wanted.at) ?? null : null);
  }, [occurrences, params]);
  const select = (o: Occurrence) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set("occ", occKey(o));
    return next;
  }, { replace: true });
  const closeSheet = () => setParams((p) => {
    const next = new URLSearchParams(p);
    next.delete("occ");
    return next;
  }, { replace: true });

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (err) {
      console.warn("[schedule] action failed", err);
    } finally {
      setBusy(false);
    }
  };

  const selectedSchedule = selected ? schedules.find((s) => s.id === selected.scheduleId) : undefined;

  const save = async (input: ScheduleInput) => {
    if (editor.target.schedule) await api.updateSchedule(editor.target.schedule.id, input);
    else await api.createSchedule(input);
    await refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        center={
          <div className="flex items-center gap-1.5 text-sm">
            <Button variant="ghost" size="icon-xs" className={headerButton} aria-label="Previous week" onClick={() => shiftWeek(-1)}><ChevronLeft /></Button>
            <Button variant="ghost" className={cn(headerButton, "h-8 px-2 text-xs")} onClick={() => setWeek(weekStart(new Date()))}>Today</Button>
            <Button variant="ghost" size="icon-xs" className={headerButton} aria-label="Next week" onClick={() => shiftWeek(1)}><ChevronRight /></Button>
            <span className="ml-2 text-xs text-muted-foreground tabular-nums">{weekRangeLabel(bounds.from)}</span>
          </div>
        }
        right={<Button size="sm" className={headerButton} onClick={() => setEditor({ open: true, target: { day: selectedDay, time: toTimeKey(9 * 60) } })}><Plus className="size-4" />New schedule</Button>}
      >
        <span className={headerTitle}>Schedule</span>
      </PageHeader>

      <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
        {/* The Work board's glass panel: the grid takes the width, the rail its fixed 72. */}
        <div className="flex h-full overflow-hidden rounded-2xl border border-foreground/10 bg-background/20 shadow-sm backdrop-blur-xl">
          <WeekGrid
            from={bounds.from}
            occurrences={visible}
            todayKey={todayKey}
            onSelect={select}
            onPickSlot={(day, minutes) => setEditor({ open: true, target: { day, time: toTimeKey(minutes) } })}
          />
          <aside className="w-72 shrink-0 space-y-6 overflow-y-auto border-l border-foreground/10 p-4">
            <MiniCalendar selected={selectedDay} onPick={pickDay} marks={marks} highlightWeek today={todayKey} />

            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Agents</h3>
              <div className="grid gap-1">
                {agentCounts.map(([id, count]) => {
                  const agent = agentOf(id);
                  return (
                    <button
                      key={id} type="button" onClick={() => toggleAgent(id)} aria-pressed={!hiddenAgents.has(id)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-foreground/5",
                        hiddenAgents.has(id) && "opacity-45",
                      )}
                    >
                      <Face id={id} size="size-5" />
                      <span className="flex-1 truncate font-medium text-foreground">{agent.name}</span>
                      <span className="tabular-nums text-muted-foreground">{count}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Routines</h3>
              <div className="grid gap-1">
                {schedules.map((s) => (
                  <div key={s.id} className={cn("flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-foreground/5", !s.enabled && "opacity-55")}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2" onClick={() => setEditor({ open: true, target: { schedule: s } })}>
                      <Face id={s.agentId} size="size-5" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{s.title}</span>
                        <span className="block truncate text-muted-foreground">{describeRecurrence(s.recurrence)}</span>
                      </span>
                    </button>
                    <Switch
                      checked={s.enabled} aria-label={s.enabled ? `Pause ${s.title}` : `Resume ${s.title}`}
                      onCheckedChange={(on) => void act(() => api.updateSchedule(s.id, { enabled: on }))}
                    />
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>

      <OccurrenceSheet
        occurrence={selected}
        schedule={selectedSchedule}
        onClose={closeSheet}
        busy={busy}
        onRunNow={() => selected && void act(() => api.runScheduleNow(selected.scheduleId))}
        onSkip={() => selected && void act(() => api.skipOccurrence(selected.scheduleId, selected.at))}
        onEdit={() => {
          if (!selectedSchedule) return;
          closeSheet();
          setEditor({ open: true, target: { schedule: selectedSchedule } });
        }}
        onToggleEnabled={() => selectedSchedule && void act(() => api.updateSchedule(selectedSchedule.id, { enabled: !selectedSchedule.enabled }))}
      />

      <ScheduleEditor
        key={editor.target.schedule?.id ?? `${editor.target.day ?? ""}@${editor.target.time ?? ""}`}
        target={editor.target}
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        onSave={save}
        onDelete={editor.target.schedule ? async () => { await api.deleteSchedule(editor.target.schedule!.id); await refresh(); } : undefined}
      />
    </div>
  );
}

/** Minutes-of-day → "HH:mm" for the editor's time prefill. */
function toTimeKey(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
