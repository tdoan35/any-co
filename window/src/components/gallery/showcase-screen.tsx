// Showcase: what the studio made, and why. Three tabs (?tab=):
// - Games: each studio-made game with its store cover, trailer, capsules, itch page and art numbers.
// - Art: every art candidate with the gate's verdict and reason (the former Gallery page).
// - Gap map: the Steam gap map Greenlight picked the games from, served by the adapter.
// Every file comes from the adapter (read-only); nothing here is game content written by the window.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUpRight, Check, FolderOpen, Map as MapIcon, X } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { Segmented, headerTitle } from "@/components/studio/studio-ui";
import { gameName, type ShowcaseGame } from "@/lib/api";
import type { GalleryEntry } from "@/lib/api/http";
import { currentApiBase } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { GalleryScreen, repoOf } from "./gallery-screen";

type Tab = "games" | "art" | "map";
const TABS = [{ value: "games", label: "Games" }, { value: "art", label: "Art" }, { value: "map", label: "Gap map" }] as const;

const abs = (url: string) => (url.startsWith("/") ? `${currentApiBase()}${url}` : url);

/**
 * The store blurb from the itch page markdown. Agents keep that file as a working doc (status notes first),
 * so prefer the section itch shows, the tagline / short description, then "About this game", then the first
 * real paragraph. Headings, links and emphasis are stripped; the result is shown as plain text.
 */
function blurbOf(md: string | null): string | undefined {
  if (!md) return undefined;
  const sections = md.split(/^#{1,6}\s+/m).map((sec) => {
    const [head = "", ...rest] = sec.split("\n");
    return { head, paras: rest.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith("![")) };
  });
  const from = (re: RegExp) => sections.find((x) => re.test(x.head))?.paras.find((p) => p.length > 40);
  const pick = from(/tagline|short description/i) ?? from(/about this game|description/i)
    ?? sections.flatMap((x) => x.paras).find((p) => p.length > 60 && !/^status:/i.test(p));
  return pick
    ?.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The store page text: the adapter sends a file URL (/api/showcase/<slug>/file/...), or inline markdown. */
function useStoreMd(storeMd: string | null) {
  const isUrl = !!storeMd && storeMd.startsWith("/api/");
  const [text, setText] = useState<string | null>(isUrl ? null : storeMd);
  useEffect(() => {
    if (!storeMd || !isUrl) return;
    let stopped = false;
    fetch(abs(storeMd)).then((r) => (r.ok ? r.text() : null)).then((t) => { if (!stopped) setText(t); }).catch(() => {});
    return () => { stopped = true; };
  }, [storeMd, isUrl]);
  return text;
}

function GameCard({ game, art }: { game: ShowcaseGame; art: { accepted: number; rejected: number } }) {
  const blurb = blurbOf(useStoreMd(game.storeMd));
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-card/70 shadow-sm backdrop-blur">
      {game.trailer
        ? <video src={abs(game.trailer)} poster={game.cover ? abs(game.cover) : undefined} controls preload="metadata" className="aspect-video w-full bg-black object-contain" />
        : game.cover
          ? <img src={abs(game.cover)} alt={`${game.name} cover`} className="aspect-[630/500] w-full bg-foreground/5 object-cover" />
          : <div className="flex aspect-video w-full items-center justify-center bg-foreground/5 text-xs text-muted-foreground">No cover yet</div>}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          {game.trailer && game.cover && <img src={abs(game.cover)} alt="" className="size-14 shrink-0 rounded-lg border border-foreground/10 object-cover" />}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{game.name}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">games/{game.game}</p>
          </div>
        </div>
        {blurb && <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground">{blurb}</p>}
        {game.capsules.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Store capsules</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {game.capsules.map((c) => (
                <a key={c} href={abs(c)} target="_blank" rel="noreferrer" className="shrink-0">
                  <img src={abs(c)} alt="" className="h-20 rounded-md border border-foreground/10 object-contain" />
                </a>
              ))}
            </div>
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-ok"><Check className="size-3" />{art.accepted} art approved</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-muted-foreground"><X className="size-3" />{art.rejected} rejected by the gate</span>
          <span className="ml-auto flex items-center gap-1">
            <Link to={`/work?project=${game.game}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
              <FolderOpen className="size-3.5" />Work
            </Link>
            {game.itchUrl && (
              <a href={game.itchUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:bg-foreground/85">
                Play on itch<ArrowUpRight className="size-3.5" />
              </a>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

function GamesTab({ games, repos, entries }: { games: ShowcaseGame[]; repos: string[]; entries: GalleryEntry[] }) {
  // Until the adapter serves /api/showcase, the repos with a gallery still get a card (name and art numbers).
  const list: ShowcaseGame[] = games.length
    ? games
    : repos.map((r) => ({ game: r, name: gameName(r), itchUrl: null, cover: null, capsules: [], trailer: null, storeMd: null }));
  const artOf = (slug: string) => {
    const mine = entries.filter((e) => repoOf(e) === slug);
    return { accepted: mine.filter((e) => e.verdict === "accepted").length, rejected: mine.filter((e) => e.verdict === "rejected").length };
  };
  if (!list.length) return <p className="m-6 rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-sm text-muted-foreground">No games yet.</p>;
  return (
    <div className="mx-auto grid max-w-6xl gap-5 p-5 md:grid-cols-2">
      {list.map((g) => <GameCard key={g.game} game={g} art={artOf(g.game)} />)}
    </div>
  );
}

const PICKS = [{ slug: "caravan-cargo-cult", name: "Caravan Cargo Cult" }, { slug: "soul-shift", name: "SOUL SHIFT" }];

function GapMapTab() {
  const url = `${currentApiBase()}/api/gapmap`;
  const [state, setState] = useState<"checking" | "ready" | "missing">("checking");
  // A pick only changes the iframe's hash: the map zooms to that game's gap without reloading the ~10 MB page.
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    // Read just the status, then drop the ~10 MB body; the iframe loads it for real.
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => { setState(r.ok ? "ready" : "missing"); ctrl.abort(); })
      .catch((err) => { if (!ctrl.signal.aborted || err?.name !== "AbortError") setState((s) => (s === "checking" ? "missing" : s)); });
    return () => ctrl.abort();
  }, [url]);
  return (
    <div className="flex h-full flex-col gap-3 p-4 pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          Every Steam game with 10+ reviews (about 56.6k), placed by similarity. Highlighted regions are open space next to proven demand;
          Greenlight picked both games from here, with no human choosing.
        </p>
        {state === "ready" && PICKS.map((p) => (
          <button key={p.slug} type="button" onClick={() => setPick(p.slug)}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${pick === p.slug ? "border-[#6d5dfc] text-foreground" : "border-foreground/15 text-muted-foreground hover:text-foreground"}`}>
            <span className="text-[#6d5dfc]" aria-hidden>★</span>{p.name}
          </button>
        ))}
        {state === "ready" && (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            Open full screen<ArrowUpRight className="size-3.5" />
          </a>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-foreground/10 bg-background/40 shadow-sm">
        {state === "ready"
          ? <iframe src={pick ? `${url}#pick=${pick}` : url} title="Steam gap map" className="size-full border-0" />
          : (
            <div className="grid size-full place-items-center px-6 text-center">
              <div className="max-w-sm space-y-2">
                <MapIcon className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
                <p className="text-sm text-muted-foreground">{state === "checking" ? "Loading the gap map…" : "The gap map isn't served by this studio's adapter yet."}</p>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

export function ShowcaseScreen({ repos, entries, games }: { repos: string[]; entries: GalleryEntry[]; games: ShowcaseGame[] }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "art" ? "art" : params.get("tab") === "map" ? "map" : "games";
  const setTab = (v: Tab) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (v === "games") n.delete("tab"); else n.set("tab", v);
    return n;
  }, { replace: true });
  const title = useMemo(() => (tab === "art" ? "Art" : tab === "map" ? "Gap map" : "Games"), [tab]);
  return (
    <div className="flex h-full flex-col">
      <PageHeader center={<Segmented value={tab} options={TABS} onChange={setTab} />}>
        <span className={cn(headerTitle, "flex items-center gap-2")}>Gallery<span className="font-normal text-muted-foreground">/ {title}</span></span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "games" && <GamesTab games={games} repos={repos} entries={entries} />}
        {tab === "art" && <GalleryScreen repos={repos} entries={entries} embedded />}
        {tab === "map" && <GapMapTab />}
      </div>
    </div>
  );
}
