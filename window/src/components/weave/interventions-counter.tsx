// Autonomy counter (goal 3): human interventions since the event start, from the studio
// ledger. This is the judges' autonomy view — calm and factual, no spin. A compact count
// with a per-category split sits in the Weave header; clicking opens the ledger: the agents'
// own decisions and the human interventions, each newest first, kept in separate tabs so
// neither is ever counted as the other. The counter fetches on mount, and the app remounts per studio switch, so each
// studio always shows its own ledger.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Hand } from "lucide-react";
import { api } from "@/lib/api";
import type { Interventions } from "@/lib/api/http";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar, InitialAvatar } from "@/components/agent-avatar";
import { registry, useRegistry } from "@/lib/registry";

/** Category shades, calm and distinguishable in both themes; unknown categories fall back. */
const CATEGORY_SHADES = ["bg-foreground/70", "bg-foreground/45", "bg-foreground/30", "bg-foreground/20"];

const tallies = (data: Interventions | undefined): Array<{ category: string; count: number }> => {
  if (!data?.by_category) return [];
  return Object.entries(data.by_category)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
};

/** One segment per category, width = share of the total. Pure decoration (aria-hidden). */
function CategoryBar({ data, className }: { data: Interventions | undefined; className?: string }) {
  const rows = tallies(data);
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (!total) return null;
  return (
    <span aria-hidden className={cn("flex h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10", className)}>
      {rows.map((r, i) => (
        <span key={r.category} className={CATEGORY_SHADES[i % CATEGORY_SHADES.length]} style={{ width: `${(r.count / total) * 100}%` }} />
      ))}
    </span>
  );
}

const timeLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const titleCase = (id: string) => id.split(/[-_]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** An agent's portrait from the registry (cast stills included), else a round initial. */
function AgentFace({ id }: { id: string }) {
  useRegistry();
  const agent = registry().agents.find((p) => p.agent.id === id)?.agent;
  const name = agent?.name ?? titleCase(id);
  return agent?.avatar
    ? <AgentAvatar avatar={agent.avatar} name={name} className="size-8 shadow-none" />
    : <InitialAvatar initial={name[0] ?? "?"} name={name} tone="bg-muted text-muted-foreground" className="size-8 text-[8px] shadow-none" />;
}

/** A human step-in: a neutral hand badge, so it never reads as an agent. */
const HumanFace = ({ who }: { who: string }) => (
  <div role="img" aria-label={who} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground">
    <Hand className="size-3.5" aria-hidden />
  </div>
);

/** "operator (Ty go via EA B)" -> name "operator", note "Ty go via EA B". */
const splitWho = (who: string) => {
  const m = /^([^(]+?)\s*\((.*)\)\s*$/.exec(who);
  return m ? { name: m[1]!, note: m[2]! } : { name: who, note: "" };
};

function Row({ face, name, note, ts, tag, title, body }: {
  face: ReactNode; name: string; note?: string; ts: string; tag?: string; title: string; body?: string;
}) {
  return (
    <li className="flex gap-3 rounded-xl border border-foreground/10 bg-card/60 p-3">
      {face}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">{name}</span>
          {tag && <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-px">{tag}</span>}
          <time className="ml-auto shrink-0 tabular-nums" dateTime={ts}>{timeLabel(ts)}</time>
        </div>
        <p className="line-clamp-3 text-xs font-medium leading-snug">{title}</p>
        {body && <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{body}</p>}
        {note && <p className="truncate text-[11px] text-muted-foreground/80">{note}</p>}
      </div>
    </li>
  );
}

function Chips({ items, value, onChange }: { items: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <Button key={it.key} variant="secondary" size="sm" aria-pressed={value === it.key}
          className="h-7 rounded-full px-2.5 text-xs aria-pressed:bg-foreground aria-pressed:text-background"
          onClick={() => onChange(it.key)}>
          {it.label}
        </Button>
      ))}
    </div>
  );
}

const newestFirst = <T extends { ts: string }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

function Interventions({ data }: { data: Interventions }) {
  const [category, setCategory] = useState("all");
  const entries = useMemo(
    () => newestFirst(data.entries).filter((e) => category === "all" || e.category === category),
    [data.entries, category],
  );
  return (
    <>
      <Chips value={category} onChange={setCategory}
        items={[{ key: "all", label: `all · ${data.count}` }, ...tallies(data).map((r) => ({ key: r.category, label: `${r.category} · ${r.count}` }))]} />
      <ol className="space-y-2">
        {entries.map((e, i) => {
          const { name, note } = splitWho(e.who);
          return <Row key={`${e.ts}-${i}`} face={<HumanFace who={e.who} />} name={name} note={note} ts={e.ts} tag={e.category} title={e.action} body={e.reason} />;
        })}
        {entries.length === 0 && <li className="text-xs text-muted-foreground">No interventions in this category.</li>}
      </ol>
    </>
  );
}

function Decisions({ data }: { data: NonNullable<Interventions["decisions"]> }) {
  const [agent, setAgent] = useState("all");
  const entries = useMemo(
    () => newestFirst(data.entries).filter((e) => agent === "all" || e.agent === agent),
    [data.entries, agent],
  );
  const agents = Object.entries(data.by_agent).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <>
      <Chips value={agent} onChange={setAgent}
        items={[{ key: "all", label: `all · ${data.count}` }, ...agents.map(([a, n]) => ({ key: a, label: `${titleCase(a)} · ${n}` }))]} />
      <ol className="space-y-2">
        {entries.map((e, i) => (
          <Row key={`${e.ts}-${i}`} face={<AgentFace id={e.agent} />} name={titleCase(e.agent)} ts={e.ts} tag={e.topic} title={e.decision} body={e.rationale} />
        ))}
        {entries.length === 0 && <li className="text-xs text-muted-foreground">No recent decisions from this agent.</li>}
      </ol>
    </>
  );
}

/** The compact header counter. Clicking opens the ledger sheet. */
export function InterventionsCounter({ data }: { data: Interventions }) {
  const [open, setOpen] = useState(false);
  const since = timeLabel(data.eventStart);
  const decisions = data.decisions;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Human interventions: ${data.count} since ${since}. Open the list.`}
        title={`Human interventions since ${since}`}
        className="h-7 gap-2 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Hand className="size-3.5" aria-hidden />
        <span className="tabular-nums">{data.count}</span>
        <CategoryBar data={data} />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-[380px] flex-col gap-0 sm:w-[440px]">
          <SheetHeader className="px-5 pt-5 pb-3">
            <SheetTitle className="text-base">Studio ledger</SheetTitle>
            <SheetDescription>
              Who made each call since {since}. Agents decide on their own; every time a person steps in, it is logged here too.
            </SheetDescription>
          </SheetHeader>
          {decisions ? (
            <Tabs defaultValue="decisions" className="min-h-0 flex-1 gap-3">
              <TabsList className="mx-5 w-auto">
                <TabsTrigger value="decisions" className="text-xs">Agent decisions · {decisions.count}</TabsTrigger>
                <TabsTrigger value="interventions" className="text-xs">Human interventions · {data.count}</TabsTrigger>
              </TabsList>
              <TabsContent value="decisions" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
                <Decisions data={decisions} />
              </TabsContent>
              <TabsContent value="interventions" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
                <Interventions data={data} />
              </TabsContent>
            </Tabs>
          ) : (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
              <Interventions data={data} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Fetches the ledger and shows the counter; hides itself only while the first load is in flight. */
export function LiveInterventionsCounter() {
  const [data, setData] = useState<Interventions | undefined>();
  useEffect(() => {
    let stopped = false;
    api.getInterventions().then((d) => { if (!stopped) setData(d); }).catch((err) => console.warn("[interventions] fetch failed", err));
    return () => { stopped = true; };
  }, []);
  if (!data) return null;
  return <InterventionsCounter data={data} />;
}
