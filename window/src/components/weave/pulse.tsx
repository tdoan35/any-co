import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Brain, CornerDownLeft, Crown, MessageSquare, ShieldCheck, ThumbsUp, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type EventEntry, type MemoryEntry, type PolicyEntry, type PulseEntry, type UpdateEntry } from "@/lib/mock/weave";
import { inboxGroups, itemById, weave, weaveCalendar, type WeaveState } from "@/lib/weave-store";
import { httpApi, httpMode, type Interventions } from "@/lib/api";
import { organizations, profileById, useRegistry, workRuns, workTasks } from "@/lib/registry";
import { cn } from "@/lib/utils";
import { dayKey, dayLabel, fmtTime, TODAY, weaveNow } from "./format";
import { ArtifactChip, Face, HealthPill, NameRole, ProjectChip, agentOf } from "./parts";

export type PulseFilter = "highlights" | "everything";

const card = "rounded-xl border border-foreground/10 bg-background/70 shadow-sm backdrop-blur-md";

function joinNodes(nodes: React.ReactNode[]) {
  return nodes.map((n, i) => (
    <Fragment key={i}>{i > 0 && (i === nodes.length - 1 ? " and " : ", ")}{n}</Fragment>
  ));
}

/** The Studio Head's written summary of what needs you. It rewrites itself as you clear asks. */
/** The autonomy score, as the ledger sees it: human messages to the studio since the event began. */
function InterventionLine() {
  const [data, setData] = useState<Interventions | undefined>();
  useEffect(() => {
    let live = true;
    const load = () => { httpApi.getInterventions().then((d) => { if (live) setData(d); }).catch(() => {}); };
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!data) return null;
  const started = Date.now() >= Date.parse(data.eventStart);
  return (
    <p className="text-xs text-muted-foreground" title={data.entries.map((e) => `${fmtTime(e.ts)} ${e.action}: ${e.reason}`).join("\n") || undefined}>
      <span className="font-medium text-foreground tabular-nums">{data.count}</span> human {data.count === 1 ? "intervention" : "interventions"} logged
      {started ? " since the event began." : ` (counting starts ${new Date(data.eventStart).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}).`}
    </p>
  );
}

function DanaBrief({ state, onSelectItem }: { state: WeaveState; onSelectItem: (id: string) => void }) {
  // Whoever heads the org writes the brief. With no `head` agent spec yet, show a placeholder.
  const headId = organizations()[0]?.headId;
  const head = headId ? profileById(headId)?.agent : undefined;
  useRegistry();
  const g = inboxGroups(state);
  const currentRuns = workRuns();
  const taskNames = new Map(workTasks().map((task) => [task.id, task.title]));
  // Runs arrive oldest-first; report the most recent. Chat turns ("Chat: …", see server/runs.ts) are not studio news.
  const newest = [...currentRuns].reverse().filter((run) => !(taskNames.get(run.taskId) ?? "").startsWith("Chat: "));
  const active = newest.find((run) => run.status === "running");
  const completed = newest.find((run) => run.status === "accepted");
  const liveLine = active ? `${taskNames.get(active.taskId) ?? "A team loop"} is underway.` : "No team loops are running yet.";
  const resultsLine = completed ? ` ${taskNames.get(completed.taskId) ?? "A team"} has results ready.` : "";
  const next = weaveCalendar()
    .filter((e) => dayKey(e.start) === TODAY && new Date(e.start) > weaveNow())
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  const link = (id: string) => (
    <button type="button" onClick={() => onSelectItem(id)} className="font-medium underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground">
      {itemById(id)?.brief}
    </button>
  );
  return (
    <section className={cn(card, "p-4")}>
      <div className="flex items-center gap-3">
        {head
          ? <Face id={head.id} size="size-10" live />
          : <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-dashed border-foreground/25 text-muted-foreground"><Crown className="size-4" /></span>}
        <div className="min-w-0 flex-1 text-xs">
          {head ? <NameRole id={head.id} className="block text-sm" /> : <span className="block text-sm font-medium">Studio Head</span>}
          <span className="text-muted-foreground">{fmtTime(weaveNow().toISOString())}</span>
        </div>
        {(head || !httpMode) && <Button size="sm" variant="ghost" asChild className="text-muted-foreground"><Link to="/">Talk to {head?.name ?? "Dana"}<ArrowRight /></Link></Button>}
      </div>
      <div className="mt-3 space-y-1.5 text-sm leading-relaxed">
        <p>{httpMode ? `${liveLine}${resultsLine}` : "The 360M run is in Implement, and the 135M results are written up."}</p>
        <p>
          {g.needs.length === 0
            ? "Nothing is waiting on you right now. I'll ask here when that changes."
            : <>{g.needs.length === 1 ? "One thing needs you: " : `${g.needs.length} things need you: `}{joinNodes(g.needs.map((i) => link(i.id)))}.</>}
          {g.forYou.length > 0 && <> When you have a minute: {link(g.forYou[0].id)}{g.forYou.length > 1 && ` and ${g.forYou.length - 1} more to read`}.</>}
        </p>
        {next && <p className="text-muted-foreground">Next on your calendar: {next.title} at {fmtTime(next.start)}.</p>}
        {httpMode && <InterventionLine />}
      </div>
    </section>
  );
}

function UpdateCard({ entry, onSelectItem }: { entry: UpdateEntry; onSelectItem: (id: string) => void }) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const author = agentOf(entry.authorId);
  const send = () => {
    if (!draft.trim()) return;
    weave.reply(entry.id, draft.trim());
    setDraft("");
    setReplying(false);
  };
  return (
    <article className={cn(card, "p-4")}>
      <div className="flex items-center gap-2 text-xs">
        <Face id={entry.authorId} size="size-6" />
        <NameRole id={entry.authorId} />
        <span className="shrink-0 text-muted-foreground">· {fmtTime(entry.at)}</span>
        <span className="ml-auto hidden min-w-0 sm:block"><ProjectChip name={entry.project} /></span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">{entry.title}</h3>
        <HealthPill health={entry.health} />
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{entry.body}</p>
      <dl className="mt-3 grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1 border-l-2 border-foreground/10 pl-3 text-xs">
        {entry.diff.map((d) => (
          <div key={d.label} className="contents">
            <dt className="text-muted-foreground">{d.label}</dt>
            <dd className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{d.from}</span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="font-medium">{d.to}</span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {entry.links.map((l) => {
          if (l.artifact) return <ArtifactChip key={l.label} name={l.label} />;
          const cls = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors";
          if (l.itemId) {
            const id = l.itemId;
            return <button key={l.label} type="button" onClick={() => onSelectItem(id)} className={cn(cls, "border-warn/30 bg-warn-soft text-warn hover:border-warn/60")}>{l.label}<ArrowRight className="size-3" /></button>;
          }
          return <Link key={l.label} to={l.href!} className={cn(cls, "border-foreground/10 bg-background/60 text-foreground hover:border-foreground/25")}>{l.label}<ArrowRight className="size-3" /></Link>;
        })}
      </div>
      {entry.replies && entry.replies.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-foreground/10 pt-3">
          {entry.replies.map((r) => (
            <li key={r.at} className="flex gap-2 text-xs">
              <Face id="you" size="size-5" />
              <span className="min-w-0 flex-1">
                <span>{r.text}</span>
                <span className="block text-muted-foreground">{fmtTime(r.at)} · sent to {author.name}, who picks it up at the next step</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {replying ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-foreground/15 bg-background/80 px-2.5 py-1.5 focus-within:border-foreground/30">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") { e.stopPropagation(); setReplying(false); }
            }}
            placeholder={`Reply to ${author.name}…`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button size="icon-xs" variant="ghost" aria-label="Send reply" onClick={send} disabled={!draft.trim()}><CornerDownLeft /></Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1 border-t border-foreground/10 pt-2.5">
          <Button size="xs" variant="ghost" aria-pressed={!!entry.acked} onClick={() => weave.toggleAck(entry.id)}
            className={cn("text-muted-foreground", entry.acked && "text-ok hover:text-ok")}>
            <ThumbsUp className={cn(entry.acked && "fill-current")} />{entry.acked ? "Acknowledged" : "Acknowledge"}
          </Button>
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setReplying(true)}>
            <MessageSquare />Reply to {author.name}
          </Button>
        </div>
      )}
    </article>
  );
}

function EventLine({ entry }: { entry: EventEntry }) {
  const name = entry.actorId === "you" ? "You" : agentOf(entry.actorId).name;
  return (
    <div className="flex items-center gap-2 px-1 text-xs" title={entry.actorId === "you" ? undefined : `${name} · ${agentOf(entry.actorId).role}`}>
      <Face id={entry.actorId} size="size-5" />
      <p className="min-w-0 flex-1 text-muted-foreground"><span className="font-medium text-foreground">{name}</span> {entry.text}</p>
      {entry.artifact && <ArtifactChip name={entry.artifact} />}
      <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(entry.at)}</span>
    </div>
  );
}

/** What a specialist learned, shown so agent memory never grows silently (PRODUCT §2.9). */
function MemoryCard({ entry }: { entry: MemoryEntry }) {
  const name = agentOf(entry.agentId).name;
  return (
    <div className="rounded-xl border border-dashed border-foreground/20 bg-background/50 px-3.5 py-3 backdrop-blur-md">
      <div className="flex items-center gap-2 text-xs">
        <Brain className="size-3.5 text-replay" />
        <span><span className="font-medium">{name}</span> <span className="text-muted-foreground">saved a lesson</span></span>
        <span className="rounded-full bg-replay-soft px-1.5 py-px text-[10px] font-medium text-replay">agent memory</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{fmtTime(entry.at)}</span>
      </div>
      <p className={cn("mt-2 text-sm", entry.decision === "forgotten" && "text-muted-foreground line-through")}>“{entry.text}”</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{entry.memoryId
          ? <>From {entry.source}. About you; {name} uses it when it's relevant.</>
          : <>From {entry.source}. Only {name} loads it; it never reaches the Studio Head's memory.</>}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          {entry.decision
            ? <>
                <span className={entry.decision === "kept" ? "text-ok" : undefined}>{entry.decision === "kept" ? "Kept" : "Forgotten"}</span>
                <Button size="xs" variant="ghost" onClick={() => weave.decideMemory(entry.id, undefined)}><Undo2 />Undo</Button>
              </>
            : <>
                <Button size="xs" variant="outline" onClick={() => weave.decideMemory(entry.id, "kept")}>Keep</Button>
                <Button size="xs" variant="ghost" onClick={() => weave.decideMemory(entry.id, "forgotten")}>Forget</Button>
              </>}
        </span>
      </div>
    </div>
  );
}

/** Autonomy you granted, kept as an audit trail. */
function PolicyLine({ entry }: { entry: PolicyEntry }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warn/20 bg-warn-soft/60 px-3 py-2 text-xs">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <p className="min-w-0 flex-1"><span className="font-medium">Policy changed.</span> {entry.text}</p>
      <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(entry.at)}</span>
    </div>
  );
}

function Entry({ entry, onSelectItem }: { entry: PulseEntry; onSelectItem: (id: string) => void }) {
  switch (entry.kind) {
    case "update": return <UpdateCard entry={entry} onSelectItem={onSelectItem} />;
    case "event": return <EventLine entry={entry} />;
    case "memory": return <MemoryCard entry={entry} />;
    case "policy": return <PolicyLine entry={entry} />;
  }
}

/** Section label with a rule to the right: "Priorities ────", "Today ────". */
function Divider({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
      {children}<span className="h-px flex-1 bg-foreground/10" />
    </h3>
  );
}

export function Pulse({ state, filter, onFilter, onSelectItem, scrollTo, animateLayout = true }: {
  state: WeaveState; filter: PulseFilter; onFilter: (f: PulseFilter) => void; onSelectItem: (id: string) => void;
  /** Set by the calendar; `n` changes on every pick so picking the same day scrolls again. */
  scrollTo: { day: string; n: number } | null;
  /** Rows slide when new entries arrive; off while a column border is dragged, or they chase every pixel. */
  animateLayout?: boolean;
}) {
  useEffect(() => {
    if (scrollTo) document.getElementById(`pulse-day-${scrollTo.day}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollTo]);

  const sorted = [...state.entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const days = [...new Set(sorted.map((e) => dayKey(e.at)))];
  return (
    <div className="mx-auto max-w-[640px] space-y-6">
      <section>
        <Divider>Priorities</Divider>
        <DanaBrief state={state} onSelectItem={onSelectItem} />
      </section>
      {days.map((day) => {
        const all = sorted.filter((e) => dayKey(e.at) === day);
        const shown = filter === "everything" ? all : all.filter((e) => !e.quiet);
        const hidden = all.length - shown.length;
        return (
          <section key={day} id={`pulse-day-${day}`} className="scroll-mt-4">
            <Divider>{dayLabel(day)}</Divider>
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {shown.map((e) => (
                  <motion.div key={e.id} layout={animateLayout ? "position" : false} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                    <Entry entry={e} onSelectItem={onSelectItem} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {hidden > 0 && (
                <button type="button" onClick={() => onFilter("everything")} className="px-1 text-xs text-muted-foreground hover:text-foreground">
                  {hidden} quiet {hidden === 1 ? "update" : "updates"} hidden · Show
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
