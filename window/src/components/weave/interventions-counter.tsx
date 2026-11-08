// Autonomy counter (goal 3): human interventions since the event start, from the studio
// ledger. This is the judges' autonomy view — calm and factual, no spin. A compact count
// with a per-category split sits in the Weave header; clicking opens the entries, newest
// first. The counter fetches on mount, and the app remounts per studio switch, so each
// studio always shows its own ledger.
import { useEffect, useMemo, useState } from "react";
import { Hand } from "lucide-react";
import { api } from "@/lib/api";
import type { Interventions } from "@/lib/api/http";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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

function Entries({ data }: { data: Interventions }) {
  const [category, setCategory] = useState("all");
  const rows = tallies(data);
  const entries = useMemo(
    () => [...data.entries]
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .filter((e) => category === "all" || e.category === category),
    [data.entries, category],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Button variant="secondary" size="sm" aria-pressed={category === "all"} className="h-7 rounded-full px-2.5 text-xs"
          onClick={() => setCategory("all")}>
          all · {data.count}
        </Button>
        {rows.map((r) => (
          <Button key={r.category} variant="secondary" size="sm" aria-pressed={category === r.category} className="h-7 rounded-full px-2.5 text-xs"
            onClick={() => setCategory(r.category)}>
            {r.category} · {r.count}
          </Button>
        ))}
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
        {entries.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="rounded-xl border border-foreground/10 bg-card/60 p-3 text-xs">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{timeLabel(e.ts)}</span>
              {e.category && <span className="rounded-full bg-foreground/10 px-1.5 py-0.5">{e.category}</span>}
              <span className="ml-auto">{e.who}</span>
            </div>
            <p className="line-clamp-3 font-medium">{e.action}</p>
            {e.reason && <p className="mt-1 line-clamp-2 text-muted-foreground">{e.reason}</p>}
          </li>
        ))}
        {entries.length === 0 && <li className="text-xs text-muted-foreground">No interventions in this category.</li>}
      </ol>
    </div>
  );
}

/** The compact header counter. Clicking opens the ledger sheet. */
export function InterventionsCounter({ data }: { data: Interventions }) {
  const [open, setOpen] = useState(false);
  const since = timeLabel(data.eventStart);
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
        <SheetContent side="right" className="flex w-[380px] flex-col gap-3 sm:w-[420px]">
          <SheetHeader>
            <SheetTitle className="text-base">Human interventions</SheetTitle>
            <SheetDescription>
              {data.count} since {since}. Every human decision in this studio's ledger.
            </SheetDescription>
          </SheetHeader>
          <Entries data={data} />
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
