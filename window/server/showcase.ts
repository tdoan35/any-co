// Showcase + gap map for the window's Gallery tabs (read-only). Every servable file is on a fixed per-game allow-list
// (no path from the request is ever joined onto the disk): /api/showcase/<slug>/file/<rel> only serves a rel the list names,
// realpath-confined to the directory it was listed under.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface ShowcaseItem {
  game: string;
  name: string;
  itchUrl: string | null;
  cover: string | null;
  capsules: string[];
  trailer: string | null;
  storeMd: string | null;
}

interface GameSpec {
  name: string;
  itchUrl: string;
  covers: string[]; // first existing wins
  capsules: string[];
  storeMd?: string;
  trailer?: { rel: string; abs: (root: string, runsDir: string) => string; base: (root: string, runsDir: string) => string };
}

const SPECS: Record<string, GameSpec> = {
  "soul-shift": {
    name: "SOUL SHIFT",
    itchUrl: "https://tdoan35gmailcom.itch.io/soul-shift",
    covers: ["store/cover-630x500-titled.png", "store/cover-630x500.png"],
    capsules: ["assets/capsule/capsule-store.png", "assets/capsule/capsule-store-v2.png", "assets/capsule/capsule-store-v3.png"],
    storeMd: "store/itch-page.md",
  },
  "caravan-cargo-cult": {
    name: "Caravan Cargo Cult",
    itchUrl: "https://tdoan35gmailcom.itch.io/caravan-cargo-cult",
    covers: ["capsule/itch_cover_630x500.png"],
    capsules: ["assets/capsule/itch_cover.png"],
    trailer: {
      rel: "trailer.mp4",
      abs: (_root, runsDir) => path.join(runsDir, "release-package-studio1", "trailer.mp4"),
      base: (_root, runsDir) => path.join(runsDir, "release-package-studio1"),
    },
  },
};

export const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".mp4": "video/mp4", ".md": "text/markdown; charset=utf-8" };

const fileUrl = (slug: string, rel: string) => `/api/showcase/${slug}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** A regular file whose realpath stays inside base (symlinks can't escape), or null. */
function confined(abs: string, base: string): string | null {
  try {
    const real = realpathSync(abs);
    const root = realpathSync(base);
    if (!real.startsWith(root + path.sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** The allow-list for one game: rel → absolute confined path (only files that exist). */
export function allowedFiles(slug: string, gamesRoot: string, runsDir: string): Map<string, string> {
  const spec = SPECS[slug];
  const out = new Map<string, string>();
  if (!spec) return out;
  const root = path.join(gamesRoot, slug);
  const add = (rel: string, abs: string, base: string) => {
    if (!CONTENT_TYPES[path.extname(rel).toLowerCase()]) return;
    const real = confined(abs, base);
    if (real) out.set(rel, real);
  };
  const cover = spec.covers.find((c) => existsSync(path.join(root, c)));
  if (cover) add(cover, path.join(root, cover), root);
  for (const c of spec.capsules) add(c, path.join(root, c), root);
  if (spec.storeMd) add(spec.storeMd, path.join(root, spec.storeMd), root);
  if (spec.trailer) add(spec.trailer.rel, spec.trailer.abs(root, runsDir), spec.trailer.base(root, runsDir));
  return out;
}

/** One showcase row per games/<slug> that has a spec and a .git. */
export function showcase(gamesRoot: string, runsDir: string): ShowcaseItem[] {
  return Object.entries(SPECS)
    .filter(([slug]) => existsSync(path.join(gamesRoot, slug, ".git")))
    .map(([slug, spec]) => {
      const files = allowedFiles(slug, gamesRoot, runsDir);
      const url = (rel: string | undefined) => (rel && files.has(rel) ? fileUrl(slug, rel) : null);
      const cover = spec.covers.find((c) => files.has(c));
      return {
        game: slug,
        name: spec.name,
        itchUrl: spec.itchUrl,
        cover: url(cover),
        capsules: spec.capsules.filter((c) => files.has(c)).map((c) => fileUrl(slug, c)),
        trailer: url(spec.trailer?.rel),
        storeMd: url(spec.storeMd),
      };
    });
}

/** The gap map to serve: the real-picks render if present, else the base map. */
export function gapmapFile(root: string): string | null {
  for (const f of ["map-pins.html", "map.html"]) {
    const p = path.join(root, "data", "gapmap", f);
    if (existsSync(p)) return p;
  }
  return null;
}
