import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CircleCheck, FileText, Hourglass, Info, OctagonPause, Pause, Sparkles, Square } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { PANEL_PATTERN, Segmented, headerTitle } from "@/components/studio/studio-ui";
import { Button } from "@/components/ui/button";
import { quietScroll } from "@/components/weave/use-edge-fade";
import { Face, NameRole, agentOf } from "@/components/weave/parts";
import { type ProposalItem } from "@/lib/mock/weave";
import type { Project } from "@/lib/mock/sessions";
import { fmtClock, fmtSpan, laneDomain, projectRun, runMarkers, teamOf, type RunView } from "@/lib/run-state";
import type { ContextSnapshot, Report, Run, RunEvent, Task } from "@/lib/types";
import { useRunClock, type ClockStart } from "@/lib/use-run-clock";
import { api, httpApi, httpMode, streamUrl } from "@/lib/api";
import { RunEventSchema } from "@fabric/contracts";
import { addSeconds, leadOf, loopState, summarize, when, whenFull, type TaskSummary } from "@/lib/work";
import { useWeave, weaveItems } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { BriefPanel } from "./brief-panel";
import { Inspector } from "./inspector";
import { Lanes, LanesLegend } from "./lanes";
import { LoopStepper } from "./loop-stepper";
import { FaceStack, Label, Meter, ReworkPips, StatePill, card } from "./parts";
import { ClockBadge, Transport } from "./transport";

export interface TaskData {
  task: Task;
  project: Project;
  loops: Run[];
  run?: Run;
  events: RunEvent[];
  snapshots: ContextSnapshot[];
  report?: Report;
  start: ClockStart;
  liveZoom?: boolean;
}

/** A task's page: its selected loop, live or replayed. Proposed tasks (no loop yet) show the proposal. */
export function TaskScreen(data: TaskData) {
  const weave = useWeave();
  const summary = useMemo(() => summarize(data.task, data.loops, weave), [data.task, data.loops, weave]);
  return (
    <div className="flex h-full flex-col">
      {data.run
        // A new loop or a new start mode gets a fresh clock.
        ? <LoopScreen key={`${data.run.id}-${data.start}`} {...data} run={data.run} summary={summary} />
        : <ProposedScreen {...data} summary={summary} />}
    </div>
  );
}

function Crumbs({ project, task }: { project: Project; task: Task }) {
  const crumb = "font-normal text-muted-foreground hover:text-foreground";
  return (
    <span className={cn(headerTitle, "flex min-w-0 items-center gap-2")}>
      <Link to="/work" className={crumb}>Work</Link><span className="font-normal text-muted-foreground">/</span>
      <Link to={`/work?project=${project.id}`} className={cn(crumb, "hidden truncate sm:inline")}>{project.name}</Link><span className="hidden font-normal text-muted-foreground sm:inline">/</span>
      <span className="truncate">{task.title}</span>
    </span>
  );
}

const Panel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
    <div className={cn("h-full overflow-y-auto rounded-2xl border border-foreground/10 bg-background/20 shadow-sm backdrop-blur-xl", PANEL_PATTERN.grid, quietScroll, className)}>{children}</div>
  </div>
);

function LoopScreen({ task, project, loops, run: initialRun, events: initialEvents, snapshots: initialSnapshots, report: initialReport, start, liveZoom, summary }: TaskData & { run: Run; summary: TaskSummary }) {
  const [, setParams] = useSearchParams();
  const [localRun, setRun] = useState<Run>();
  const [localEvents, setEvents] = useState<RunEvent[]>();
  const [localSnapshots, setSnapshots] = useState<ContextSnapshot[]>();
  const [localReport, setReport] = useState<Report>();
  const run = localRun?.status !== "running" && localRun ? localRun
    : initialRun.recording || initialRun.status !== "running" ? initialRun : localRun ?? initialRun;
  const events = run === initialRun ? initialEvents : localEvents ?? initialEvents;
  const snapshots = localSnapshots ?? initialSnapshots;
  const report = localReport ?? initialReport;
  const [streaming, setStreaming] = useState(false);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const lastSeq = useRef(Math.max(0, ...initialEvents.map((e) => e.seq)));
  const finalizing = useRef(false);
  const team = teamOf(run);
  const lead = leadOf(team);
  const markers = useMemo(() => runMarkers(events), [events]);
  const stops = useMemo(() => markers.filter((mk) => mk.kind === "bounce" || mk.kind === "accept").map((mk) => mk.t), [markers]);
  const clock = useRunClock(run.durationS, start, stops, httpMode && run.status === "running" && !run.recording ? run.startedAt : undefined, !httpMode || !run.recording);
  // A live run's open lanes end at the last fetch's "now"; stretch them to the ticking clock so a
  // member who is still working reads as working between step events.
  const liveRun = httpMode && run.status === "running" && !run.recording;
  const shown = useMemo(() => (!liveRun || clock.max <= run.durationS ? run : {
    ...run,
    durationS: clock.max,
    segments: run.segments.map((s) => (s.end >= run.durationS - 0.5 ? { ...s, end: clock.max } : s)),
  }), [liveRun, run, clock.max]);
  const view = useMemo(() => projectRun(shown, events, clock.t), [shown, events, clock.t]);
  const [selected, setSelected] = useState<string>();
  const member = view.members.find((m) => m.agentId === selected);
  const isLatest = run.id === summary.latest?.id;
  const domain = laneDomain(shown, clock.t, (start === "sim" || !!liveZoom) && clock.source === "live");

  useEffect(() => {
    if (!httpMode || run.status !== "running" || run.recording) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refetch: { run?: ReturnType<typeof setTimeout>; snapshots?: ReturnType<typeof setTimeout> } = {};
    const connect = () => {
      if (closed) return;
      const source = new EventSource(streamUrl(`/runs/${encodeURIComponent(run.id)}/stream?after=${lastSeq.current}`));
      sourceRef.current = source;
      source.onopen = () => setStreaming(true);
      // Bursts (a terminal streaming, four lanes at once) arrive faster than the loop view should
      // re-render: buffer events and flush them together, and debounce the refetches they trigger.
      let pending: RunEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        flushTimer = undefined;
        if (closed || !pending.length) return;
        const batch = pending;
        pending = [];
        setEvents((prior) => [...(prior ?? initialEvents), ...batch]);
      };
      const later = (key: "run" | "snapshots", fn: () => void) => {
        if (refetch[key]) return;
        refetch[key] = setTimeout(() => { refetch[key] = undefined; if (!closed) fn(); }, 400);
      };
      source.addEventListener("run", (message) => {
        const parsed = RunEventSchema.safeParse(JSON.parse((message as MessageEvent).data));
        if (!parsed.success) { console.warn("[run stream] invalid event", parsed.error.issues); return; }
        const event = parsed.data;
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        pending.push(event);
        flushTimer ??= setTimeout(flush, 200);
        if (event.type === "step.started" || event.type === "step.finished") {
          later("run", () => void api.getRun(run.id).then((next) => { if (!closed && next) setRun(next); }));
        }
        if (event.type === "context.snapshot") {
          later("snapshots", () => void api.getSnapshots(run.id).then((next) => { if (!closed) setSnapshots(next); }));
        }
        if (event.type === "run.finished") {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          source.close(); setStreaming(false);
          void api.getRun(run.id).then((next) => { if (!closed && next) setRun(next); });
        }
      });
      source.onerror = () => { source.close(); setStreaming(false); if (!closed) retry = setTimeout(connect, 1000); };
    };
    connect();
    return () => {
      closed = true; sourceRef.current?.close(); setStreaming(false);
      if (retry) clearTimeout(retry);
      if (refetch.run) clearTimeout(refetch.run);
      if (refetch.snapshots) clearTimeout(refetch.snapshots);
    };
  }, [run.id, run.status, run.recording, initialEvents]);

  const fastForward = useCallback(async () => {
    if (httpMode && run.teamId !== "dana" && run.status === "running" && !run.recording) {
      sourceRef.current?.close(); setStreaming(false);
      const at = clock.t;
      try {
        const spliced = await httpApi.spliceRun(run.id, at);
        setRun(spliced.run); setEvents(spliced.events);
        lastSeq.current = Math.max(0, ...spliced.events.map((e) => e.seq));
        clock.fastForwardFrom(at);
      } catch (err) { console.warn("[run] splice failed", err); }
    } else clock.fastForward();
  }, [run.id, run.teamId, run.status, run.recording, clock]);
  useEffect(() => {
    if (!httpMode || run.recording?.spliceT === undefined || run.status !== "running" || clock.t < run.durationS || clock.playing || finalizing.current) return;
    finalizing.current = true;
    void httpApi.finalizeSplice(run.id).then(async ({ reportId }) => {
      const [nextRun, nextEvents, nextReport] = await Promise.all([api.getRun(run.id), api.getRunEvents(run.id), api.getReport(reportId)]);
      if (nextRun) setRun(nextRun);
      setEvents(nextEvents); setReport(nextReport);
    }).catch((err) => { finalizing.current = false; console.warn("[run] finalize failed", err); });
  }, [run.id, run.status, run.recording, run.durationS, clock.t, clock.playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable='true']") || e.metaKey || e.ctrlKey) return;
      if (e.key === "r" || e.key === "R") void fastForward();
      if (e.key === "Escape") setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fastForward]);

  // At the end (or at "now"), the loop's real state; anywhere earlier, the state at the playhead.
  const atEnd = clock.t >= clock.max;
  const final = isLatest ? loopState(summary) : run.status === "accepted" ? "accepted" : "stopped";
  const state = atEnd ? final : view.stages.find((s) => s.label === view.currentStage)?.gate ? "review" : "running";
  const loopOptions = loops.map((l) => ({ value: String(l.n), label: `Loop ${l.n}` }));

  return (
    <>
      <PageHeader
        right={<>
          {loops.length > 1 && (
            <Segmented value={String(run.n)} options={loopOptions}
              onChange={(n) => setParams((p) => { const x = new URLSearchParams(p); x.delete("live"); if (Number(n) === loops[loops.length - 1].n) x.delete("loop"); else x.set("loop", n); return x; })} />
          )}
          <ClockBadge clock={clock} start={start} liveActive={!httpMode || streaming} />
        </>}
      >
        <Crumbs project={project} task={task} />
      </PageHeader>
      <Panel>
        {/* Side by side only when the lanes still get room; narrower, the Brief follows the loop. */}
        <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
          <div className="min-w-0 space-y-4">
            {/* A run header, not a banner: the page header above is the banner (a11y). */}
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Face id={lead} size="size-5" />
                {run.teamId === "dana"
                  ? <span className="font-medium text-foreground">Dana · direct errand</span>
                  : <Link to={`/work?view=teams&team=${team.id}`} className="font-medium text-foreground hover:underline hover:underline-offset-2">{team.name}</Link>}
                <span>· {run.teamId !== "dana" && <>{agentOf(lead).name} leads · </>}Loop {run.n}{loops.length > 1 && ` of ${loops.length}`} · started {whenFull(run.startedAt)}</span>
              </div>
              <h1 className="mt-1.5 text-xl font-semibold tracking-tight">{run.objective}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatePill state={state} />
                {run.recorded && <span className="rounded-full bg-replay-soft px-1.5 py-px text-[11px] font-medium text-replay">Recorded loop</span>}
                {start === "sim" && clock.source === "live" && <span>Live start, simulated from the recorded loop</span>}
                {!isLatest && <Link to={`/work/${task.id}`} className="underline decoration-foreground/25 underline-offset-2 hover:text-foreground">Go to the latest loop</Link>}
              </div>
            </div>

            {/* The live start replays the loop's beginning, so today's asks about it would be out of place. */}
            {isLatest && start !== "sim" && <WaitingOnYou summary={summary} />}

            <Stats run={shown} view={view} t={clock.t} summary={isLatest ? summary : undefined} />

            <section className={cn(card, "overflow-hidden")}>
              <div className="px-4 pb-3 pt-4">
                <LoopStepper stages={view.stages} reworkUsed={view.reworkUsed} reworkBudget={run.reworkBudget} leadName={agentOf(lead).name} />
              </div>
              <VerdictLine view={view} lead={lead} halt={clock.halt} />
            </section>

            <section className={cn(card, "overflow-hidden")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-foreground/10 px-4 py-2.5">
                <h2 className="text-sm font-medium">Who did what</h2>
                <span className="ml-auto"><LanesLegend /></span>
              </div>
              <Lanes run={shown} team={team} view={view} t={clock.t} domain={domain} selected={selected} onSelect={(id) => setSelected((s) => (s === id ? undefined : id))} />
              <Transport clock={{ ...clock, fastForward: () => { void fastForward(); } }} max={clock.max} markers={markers} start={run.recording?.spliceT !== undefined ? "end" : start} />
            </section>

            <Callouts run={shown} view={view} report={report} summary={isLatest ? summary : undefined} />

            {view.artifacts.length > 0 && (
              <section>
                <Label className="mb-2 px-1">Artifacts</Label>
                <div className="flex flex-wrap gap-2">
                  {view.artifacts.map((a) => (
                    <span key={a.name} className="inline-flex items-center gap-2 rounded-lg border border-foreground/10 bg-background/60 py-1 pl-2 pr-1.5 text-xs" title={`${a.by ? agentOf(a.by).name : "Team"} · ${fmtClock(a.t)}`}>
                      <FileText className="size-3.5 text-muted-foreground" /><span className="font-mono">{a.name}</span>{a.by && <Face id={a.by} size="size-4" />}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>

          <aside className={cn(card, "overflow-hidden xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100svh-var(--titlebar-height)-9rem)] xl:flex-col")}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={member?.agentId ?? "brief"} className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none" tabIndex={0} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                {member
                  ? <Inspector member={member} run={shown} view={view} t={clock.t} snapshots={snapshots} onClose={() => setSelected(undefined)} />
                  : <BriefPanel run={run} criteria={view.criteria} teamName={team.name} />}
              </motion.div>
            </AnimatePresence>
          </aside>
        </div>
      </Panel>
    </>
  );
}

/** The asks this task has open in Weave. Decided there, never here, so there's one place to say yes. */
function WaitingOnYou({ summary }: { summary: TaskSummary }) {
  if (summary.note) {
    return <p className={cn(card, "flex items-start gap-2 px-3.5 py-2.5 text-xs")}><Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span>{summary.note} <span className="text-muted-foreground">The mock has no recording of what happens next.</span></span></p>;
  }
  if (!summary.asks.length) return null;
  return (
    <section className="rounded-xl border border-warn/30 bg-warn-soft/50 p-3.5 backdrop-blur-md">
      <Label className="text-warn"><Hourglass className="size-3.5" />Waiting on you · {summary.asks.length}</Label>
      <ul className="mt-2 space-y-1.5">
        {summary.asks.map((a) => (
          <li key={a.id}>
            <Link to={`/weave?item=${a.id}`} className="group flex items-center gap-2.5 rounded-lg bg-background/60 px-2.5 py-2 transition-colors hover:bg-background/90">
              <Face id={a.agentId} size="size-6" />
              <span className="min-w-0 flex-1 text-xs">
                <NameRole id={a.agentId} className="block" />
                <span className="block truncate text-[13px]">{a.title}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">Decide in Studio<ArrowRight className="size-3" /></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Budgets as stat tiles: rework and time against their limits, and Dana's own context for scale. */
function Stats({ run, view, t, summary }: { run: Run; view: RunView; t: number; summary?: TaskSummary }) {
  const reworkBudget = summary?.reworkBudget ?? run.reworkBudget;
  const spent = reworkBudget > 0 && view.reworkUsed >= reworkBudget;
  const ongoing = run.status === "running" || run.status === "blocked";
  const tile = "min-w-0 space-y-1.5 px-4 py-3";
  return (
    <section className={cn(card, "grid grid-cols-3 divide-x divide-foreground/10")}>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">Rework</div>
        <div className={cn("text-base font-semibold tabular-nums", spent && "text-warn")}>{view.reworkUsed} <span className="text-xs font-normal text-muted-foreground">of {reworkBudget}</span></div>
        <ReworkPips used={view.reworkUsed} budget={reworkBudget} />
      </div>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">{ongoing && run.etaS ? `Time · ETA ${when(addSeconds(run.startedAt, run.etaS))}` : "Time"}</div>
        <div className="text-base font-semibold tabular-nums">{fmtSpan(t)} <span className="text-xs font-normal text-muted-foreground">of {fmtSpan(run.budget.timeS)}</span></div>
        <Meter value={t} max={run.budget.timeS} tone={t / run.budget.timeS > 0.8 ? "warn" : "run"} label={`Time ${fmtSpan(t)} of ${fmtSpan(run.budget.timeS)}`} />
      </div>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">Studio Head's context</div>
        <div className="text-base font-semibold tabular-nums">{(run.assistantTokens / 1000).toFixed(1)}k <span className="text-xs font-normal text-muted-foreground">tokens</span></div>
        {run.teamId === "dana"
          ? <div className="truncate text-[11px] text-muted-foreground">Browser result only · no inner transcript</div>
          : <div className="truncate text-[11px] text-muted-foreground" title="The team got a brief, not your chat">Team brief: {(run.brief.tokens / 1000).toFixed(1)}k</div>}
      </div>
    </section>
  );
}

/** The review step's latest verdict, under the loop it acts on. Fast playback pauses here. */
function VerdictLine({ view, lead, halt }: { view: RunView; lead: string; halt?: number }) {
  const v = view.verdicts[view.verdicts.length - 1];
  return (
    <AnimatePresence initial={false}>
      {v && (
        <motion.div key={v.t} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
          className={cn("border-t", v.verdict === "accept" ? "border-ok/20 bg-ok-soft/60" : "border-warn/25 bg-warn-soft/60")}>
          <div className="flex gap-2.5 px-4 py-3">
            {v.by && <Face id={v.by} size="size-7" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className={cn("font-medium", v.verdict === "accept" ? "text-ok" : "text-warn")}>
                  {v.verdict === "accept" ? "Accepted" : `Changes requested → back to ${agentOf(lead).name}`}
                </span>
                <span className="text-xs text-muted-foreground">{v.by && agentOf(v.by).name} · {fmtClock(v.t)}</span>
                {halt === v.t && <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><Pause className="size-3" />Paused on the verdict · press play to go on</span>}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed">{v.text}</p>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** How the loop ended, or why it stopped. */
function Callouts({ run, view, report, summary }: { run: Run; view: RunView; report?: Report; summary?: TaskSummary }) {
  const accepted = view.finished && run.status === "accepted";
  return (
    <AnimatePresence initial={false}>
      {accepted && (
        <motion.section key="done" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn(card, "p-4")}>
          <div className="flex flex-wrap items-center gap-2.5">
            <CircleCheck className="size-5 text-ok" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Results are ready{report && <>: <span className="font-semibold">{report.title}</span></>}</div>
              <p className="text-xs text-muted-foreground">{run.outcome}</p>
            </div>
            {run.reportId && <Button size="sm" asChild><Link to={`/reports/${run.reportId}`}>Open report<ArrowRight /></Link></Button>}
          </div>
          {report && (
            <table className="mt-3 w-full text-xs">
              <tbody className="divide-y divide-foreground/10">
                {report.results.filter((r) => r.valid).map((r) => (
                  <tr key={r.config}><td className="py-1.5">{r.config}</td><td className="py-1.5 text-right font-mono tabular-nums">{r.ppl}</td><td className="w-16 py-1.5 text-right tabular-nums text-muted-foreground">{r.delta}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </motion.section>
      )}
      {view.stopped && (
        <motion.section key="stopped" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn(card, "flex items-start gap-2.5 p-4 text-sm")}>
          <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{view.stopped.text}</span>
        </motion.section>
      )}
      {view.blocked && !summary?.note && (
        <motion.section key="blocked" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn-soft/60 p-4 text-sm">
          <OctagonPause className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>
            {run.teamId === "dana"
              ? <><span className="font-medium">Browser stopped.</span> {view.blocked.reason}</>
              : <><span className="font-medium">Stopped on its budget.</span> {view.blocked.reason}. The escalation went member → lead → Studio Head → you, and nothing else runs until you decide.</>}
            {summary?.outcome && <span className="mt-1 block text-xs text-muted-foreground">You decided in Studio: {summary.outcome.text}</span>}
          </span>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/** A task Dana proposed that hasn't run yet. The decision lives in Weave. */
function ProposedScreen({ task, project, summary }: TaskData & { summary: TaskSummary }) {
  const item = weaveItems().find((i) => i.id === task.proposal?.itemId) as ProposalItem | undefined;
  const lead = leadOf(summary.team);
  return (
    <>
      <PageHeader right={task.preview && <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">Preview</span>}>
        <Crumbs project={project} task={task} />
      </PageHeader>
      <Panel>
        <div className="mx-auto max-w-[640px] space-y-4 p-6">
          <article className={cn(card, "space-y-4 p-5")}>
            <header className="flex items-center gap-3">
              <Face id="dana" size="size-10" kind="proposal" />
              <div className="min-w-0 flex-1 text-sm">
                <NameRole id="dana" className="block" />
                <span className="text-xs text-muted-foreground">Proposed {task.proposal && whenFull(task.proposal.at)}</span>
              </div>
              <StatePill state={loopState(summary)} />
            </header>
            <h1 className="text-lg font-semibold leading-snug tracking-tight">{task.title}</h1>
            <p className="text-sm leading-relaxed">{task.proposal?.purpose}</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <FaceStack ids={summary.team.members.map((m) => m.agentId)} size="size-7" />
              <span>{summary.team.name} · {agentOf(lead).name} would lead · {summary.team.workflow.map((w) => w.label).join(" → ")}</span>
            </div>
            {item && (
              <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-foreground/10 bg-background/60 px-3 py-2.5 text-xs">
                <dt className="text-muted-foreground">Goes to {agentOf(lead).name}</dt><dd>{item.crosses}</dd>
                <dt className="text-muted-foreground">Stays with the Studio Head</dt><dd>{item.stays}</dd>
              </dl>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-4">
              {summary.proposal
                ? <Button size="sm" asChild><Link to={`/weave?item=${summary.proposal.id}`}><Sparkles />Decide in Studio<ArrowRight /></Link></Button>
                : <span className="text-xs text-muted-foreground">{summary.note ?? "Decided in Studio."}</span>}
              {task.preview && <span className="text-xs text-muted-foreground">Preview: no Product Team loop is recorded yet, so there's nothing to play here.</span>}
            </div>
          </article>
        </div>
      </Panel>
    </>
  );
}
