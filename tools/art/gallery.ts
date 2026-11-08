// Art gallery (T18): every contact sheet and rejected candidate is kept, never overwritten.
// Files live in the GAME CLONE at art/gallery/<asset-id>/<n>-<provider>-<verdict>.png — review
// material, not game assets — plus a gallery.json index. The asset gate and exports exclude it
// (it is not listed in assets/manifest.json and is not under assets/).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderName } from "./generate.ts";

export const GALLERY_DIR = "art/gallery";

export type GalleryVerdict = "accepted" | "rejected";

export interface GalleryEntry {
  asset: string; // game-repo-relative asset id (manifest id) or derived name for sheets
  file: string; // repo-relative PNG path, art/gallery/...
  provider: ProviderName | "contact-sheet";
  verdict: GalleryVerdict;
  reason: string;
  /** art_gate numbers copied verbatim (offPaletteShare, maxFrameDrift, anchorDrift, pass). */
  gate: Record<string, unknown> | null;
  run_id: string;
  ts: string;
}

export interface GalleryIndex {
  schema_version: 1;
  entries: GalleryEntry[];
}

const GALLERY_INDEX_NAME = "gallery.json";

export function galleryIndexFile(repoRoot: string): string {
  return path.join(repoRoot, GALLERY_DIR, GALLERY_INDEX_NAME);
}

export function readGalleryIndex(repoRoot: string): GalleryIndex {
  const file = galleryIndexFile(repoRoot);
  if (!existsSync(file)) return { schema_version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GalleryIndex>;
    return { schema_version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { schema_version: 1, entries: [] }; // a torn index must not block the next write
  }
}

/** Atomic write: a reader mid-index never sees a half-written JSON. */
export function writeGalleryIndex(repoRoot: string, index: GalleryIndex) {
  const file = galleryIndexFile(repoRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Lowest unused ordinal for an asset — gallery files are never overwritten, only added. */
export function nextGalleryOrdinal(repoRoot: string, asset: string): number {
  const dir = path.join(repoRoot, GALLERY_DIR, asset);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(\d+)-/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Record one gallery image: copy nothing, just index what the caller already wrote.
 *  `file` is repo-relative (art/gallery/...); the PNG must exist — an index entry without
 *  pixels is a lie the gallery endpoint would serve as a broken image. */
export function recordGalleryImage(
  repoRoot: string,
  entry: {
    asset: string;
    file: string;
    provider: ProviderName | "contact-sheet";
    verdict: GalleryVerdict;
    reason: string;
    gate?: Record<string, unknown> | null;
    run_id?: string;
  },
  now = new Date(),
): GalleryEntry {
  if (!existsSync(path.join(repoRoot, entry.file))) throw new Error(`gallery entry for a missing file: ${entry.file}`);
  if (!entry.file.startsWith(`${GALLERY_DIR}/`)) throw new Error(`gallery files live under ${GALLERY_DIR}/, got "${entry.file}"`);
  const index = readGalleryIndex(repoRoot);
  const full: GalleryEntry = {
    asset: entry.asset,
    file: entry.file,
    provider: entry.provider,
    verdict: entry.verdict,
    reason: entry.reason,
    gate: entry.gate ?? null,
    run_id: entry.run_id ?? "unknown",
    ts: now.toISOString(),
  };
  index.entries.push(full);
  writeGalleryIndex(repoRoot, index);
  return full;
}
