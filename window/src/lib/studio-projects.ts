// Sidebar "Projects", live mode (sidebar brief): every studio's game, derived from the
// studios' own adapters — GET /api/art-gallery reports each studio's game repo slugs. The
// window carries no game names: the display name is the slug title-cased, and a studio with
// no repo yet (or an unreachable adapter) falls back to its configured label.
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
  /** The studio's first game repo slug; undefined until the adapter reports one. */
  slug?: string;
  /** Title-cased slug, or the studio label while there is no repo to name. */
  name: string;
}

/**
 * One game per configured studio, in config order — the folder list for the sidebar's
 * Projects section. Single-studio mode (no VITE_STUDIOS) derives the one game from the
 * single API base exactly the same way, so every launcher behaves alike. Fetches run once
 * on mount and again on a slow refresh; a failed fetch keeps the last good answer (the
 * studio label to start with) and never blocks the sidebar.
 */
export function useStudioProjects(fetchGallery: GalleryFetcher = httpFetcher): StudioGame[] {
  const { studios } = useStudio();
  const list = useMemo<Studio[]>(
    // No VITE_STUDIOS: one implicit studio on the single API base, like the rest of the app.
    () => (studios.length ? studios : [{ id: "single", label: "any-co", api: singleApiBase }]),
    [studios],
  );
  const [slugs, setSlugs] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const results = await Promise.allSettled(list.map((studio) => fetchGallery(studio.api)));
      if (stopped) return;
      setSlugs((prev) => {
        const next = { ...prev };
        results.forEach((result, i) => {
          const studio = list[i];
          if (result.status === "fulfilled") next[studio.id] = result.value.repos[0];
          else console.warn(`[projects] ${studio.label}: game list unavailable (${result.reason})`);
        });
        return next;
      });
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [list, fetchGallery]);

  return list.map((studio) => {
    const slug = slugs[studio.id];
    return { studio, slug, name: slug ? gameName(slug) : studio.label };
  });
}
