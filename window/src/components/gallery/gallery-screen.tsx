// Art gallery (goal 2): every kept art candidate and contact sheet from the studio game
// repo(s), served read-only by the adapter (T18). Candidates for the same asset sit side
// by side; the lightbox shows the art-gate numbers and the reviewer's reason. Pixel art is
// never smooth-scaled: nearest-neighbour rendering at integer multiples only.
import { useMemo, useState } from "react";
import { Check, ImageIcon, X } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { GalleryEntry } from "@/lib/api/http";
import { currentApiBase } from "@/lib/studio";
import { cn } from "@/lib/utils";

/** Adapter urls are base-relative (/api/art-gallery/...); fixture urls are absolute data URIs. */
const pixelsUrl = (url: string) => (url.startsWith("/") ? `${currentApiBase()}${url}` : url);

const FAMILIES = ["sprites", "tiles", "ui", "capsule", "sheets"] as const;
type Family = (typeof FAMILIES)[number] | "other";

/** The asset id says what it is (sprite-hero, tile-grass, ui-healthbar, capsule-main, sheet-pass-1). */
export const familyOf = (asset: string): Family => {
  const a = asset.toLowerCase();
  if (a.startsWith("sprite")) return "sprites";
  if (a.startsWith("tile")) return "tiles";
  if (a.startsWith("ui")) return "ui";
  if (a.startsWith("capsule")) return "capsule";
  if (a.startsWith("sheet")) return "sheets";
  return "other";
};

const VERDICT = {
  accepted: { label: "accepted", chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  rejected: { label: "rejected", chip: "bg-red-500/10 text-red-600 dark:text-red-400" },
} as const;

function VerdictChip({ verdict }: { verdict: GalleryEntry["verdict"] }) {
  const v = VERDICT[verdict];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", v.chip)}>
      {verdict === "accepted" ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
      {v.label}
    </span>
  );
}

/** One candidate: pixelated thumbnail, verdict and provider under it, click opens the lightbox. */
function Candidate({ entry, onOpen }: { entry: GalleryEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${entry.asset}, ${entry.provider}, ${VERDICT[entry.verdict].label}. Open details`}
      className="group flex w-36 shrink-0 flex-col gap-1.5 rounded-xl border border-foreground/10 bg-card/60 p-2 text-left transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* 32 px art at 128 px = integer 4×. Never smooth-scale pixel art. */}
      <img
        src={pixelsUrl(entry.url)}
        alt={`${entry.asset} candidate by ${entry.provider}`}
        width={128}
        height={128}
        loading="lazy"
        className="h-32 w-32 self-center rounded-md bg-checker [image-rendering:pixelated]"
      />
      <span className="flex items-center justify-between gap-1">
        <VerdictChip verdict={entry.verdict} />
        <span className="truncate text-[11px] text-muted-foreground">{entry.provider}</span>
      </span>
    </button>
  );
}

/** The lightbox: the candidate at 8×, the gate numbers, the reason, the run that made it. */
function Lightbox({ entry, onClose }: { entry: GalleryEntry | undefined; onClose: () => void }) {
  return (
    <Dialog open={!!entry} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        {entry && <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {entry.asset}
              <VerdictChip verdict={entry.verdict} />
              <Badge variant="secondary" className="ml-auto">{entry.provider}</Badge>
            </DialogTitle>
            <DialogDescription className="sr-only">Art candidate details</DialogDescription>
          </DialogHeader>
          <img
            src={pixelsUrl(entry.url)}
            alt={`${entry.asset} candidate by ${entry.provider}, enlarged`}
            width={256}
            height={256}
            className="self-center rounded-lg bg-checker [image-rendering:pixelated]"
          />
          <p className="text-sm text-muted-foreground">{entry.reason}</p>
          {entry.gate ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-foreground/10 p-3 text-xs">
              {Object.entries(entry.gate).map(([key, value]) => (
                <div key={key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="font-mono">{value === null ? "—" : String(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">Contact sheet: no gate numbers.</p>
          )}
          <p className="font-mono text-[11px] text-muted-foreground">{entry.runId} · {entry.ts}</p>
        </>}
      </DialogContent>
    </Dialog>
  );
}

/** A pill filter group: "All" plus one toggle per option. */
function FilterGroup({ label, options, value, onChange }: { label: string; options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {["all", ...options].map((option) => (
        <Button
          key={option}
          variant="ghost"
          size="sm"
          aria-pressed={value === option}
          className={cn("h-7 rounded-full px-2.5 text-xs", value === option && "bg-foreground/10 font-medium text-foreground")}
          onClick={() => onChange(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

export interface GalleryScreenProps {
  /** Game repos with a gallery index; names come from the API, never from code. */
  repos: string[];
  entries: GalleryEntry[];
}

export function GalleryScreen({ repos, entries }: GalleryScreenProps) {
  const [provider, setProvider] = useState("all");
  const [verdict, setVerdict] = useState("all");
  const [family, setFamily] = useState("all");
  const [open, setOpen] = useState<GalleryEntry | undefined>();

  const providers = useMemo(() => [...new Set(entries.map((e) => e.provider))].sort(), [entries]);
  const shown = entries.filter((e) =>
    (provider === "all" || e.provider === provider) &&
    (verdict === "all" || e.verdict === verdict) &&
    (family === "all" || familyOf(e.asset) === family));
  // Candidates for one asset sit together, newest first inside the group.
  const groups = useMemo(() => {
    const by = new Map<string, GalleryEntry[]>();
    for (const e of [...shown].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))) {
      const list = by.get(e.asset) ?? [];
      list.push(e);
      by.set(e.asset, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        right={<>
          {repos.length > 0 && <span className="font-mono text-[11px] text-muted-foreground">{repos.join(" · ")}</span>}
          <span className="text-xs text-muted-foreground">{groups.length} assets · {shown.length} candidates</span>
        </>}
      >
        <span className="text-sm font-medium">Gallery</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-3">
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <FilterGroup label="Provider" options={providers} value={provider} onChange={setProvider} />
          <FilterGroup label="Verdict" options={["accepted", "rejected"]} value={verdict} onChange={setVerdict} />
          <FilterGroup label="Family" options={FAMILIES} value={family} onChange={setFamily} />
        </div>
        {entries.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="max-w-sm space-y-2">
              <ImageIcon className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
              <h2 className="text-lg font-semibold">Nothing in the gallery yet</h2>
              <p className="text-sm text-muted-foreground">
                Kept art candidates appear here as agents merge their branches into the game repo.
              </p>
            </div>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No candidates match these filters.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map(([asset, candidates]) => (
              <Card key={asset} className="p-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="truncate text-sm font-medium">{asset}</h3>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{familyOf(asset)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {candidates.map((entry) => <Candidate key={`${entry.runId}/${entry.file}`} entry={entry} onOpen={() => setOpen(entry)} />)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      <Lightbox entry={open} onClose={() => setOpen(undefined)} />
    </div>
  );
}
