// Sidebar "Projects" (goal 4: one studio may run several games): every game repo each
// configured studio reports — GET /api/art-gallery lists them in `repos`. The window
// carries no game names: a folder's display name is the repo slug title-cased, and a
// studio that reports no repo yet (or is unreachable) falls back to its configured label.
import { useEffect, useMemo, useState } from "react";
import { singleApiBase, useStudio, type Studio } from "@/lib/studio";

/**
 * The slice of GET /api/art-gallery the sidebar reads: the game repo slugs. The endpoint
 * also carries art entries; the sidebar never looks at them, so it takes no dependency on
 * that contract.
 */
interface ArtGalleryIndex {
  repos: string[];
}

/** How one studio's game list is fetched. Injectable so stories run fixture data offline. */
export type GalleryFetcher = (api: string) => Promise<ArtGalleryIndex>;

/** Slow refresh: games are picked once and renamed rarely; this only catches that. */
const REFRESH_MS = 60_000;

const httpFetcher: GalleryFetcher = async (api) => {
  const response = await fetch(`${api}/api/art-gallery`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as ArtGalleryIndex;
};

/** `caravan-cargo-cult` → "Caravan Cargo Cult"; repo slugs are lowercase and dash-separated. */
export function gameName(slug: string): string {
  return slug.split("-").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export interface StudioGame {
  studio: Studio;
  /** The game repo slug this folder filters runs by; undefined on a studio-level folder. */
  slug?: string;
  /** Title-cased slug, or the studio label on a studio-level folder. */
  name: string;
}

/** One folder per repo a studio reports, in adapter order; a studio with no repos yet
 *  gets a single label-named folder (the pre-goal-4 shape). */
function foldersFor(studio: Studio, repos: string[] | undefined): StudioGame[] {
  if (!repos?.length) return [{ studio, name: studio.label }];
  return repos.map((slug) => ({ studio, slug, name: gameName(slug) }));
}

/**
 * Every configured studio's game folders, flat and in config order. The sidebar's Projects
 * section uses it only for the studios that are not active (their Work data is not loaded);
 * the active studio's projects come from the Work view itself. Single-studio mode (no VITE_STUDIOS) derives its games
 * from the single API base exactly the same way, so every launcher behaves alike. Fetches
 * run once on mount and again on a slow refresh; a failed fetch keeps the last good answer
 * (the studio label to start with) and never blocks the sidebar.
 */
export function useStudioProjects(fetchGallery: GalleryFetcher = httpFetcher, exclude?: string): StudioGame[] {
  const { studios } = useStudio();
  const list = useMemo<Studio[]>(
    // No VITE_STUDIOS: one implicit studio on the single API base, like the rest of the app.
    // `exclude` skips a studio whose projects the caller already has (the active one).
    () => (studios.length ? studios : [{ id: "single", label: "any-co", api: singleApiBase }]).filter((s) => s.id !== exclude),
    [studios, exclude],
  );
  const [repos, setRepos] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const results = await Promise.allSettled(list.map((studio) => fetchGallery(studio.api)));
      if (stopped) return;
      setRepos((prev) => {
        const next = { ...prev };
        results.forEach((result, i) => {
          const studio = list[i];
          if (result.status === "fulfilled") next[studio.id] = result.value.repos;
          else console.warn(`[projects] ${studio.label}: game list unavailable (${result.reason})`);
        });
        return next;
      });
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [list, fetchGallery]);

  return list.flatMap((studio) => foldersFor(studio, repos[studio.id]));
}
