// Gallery fixtures (goal 2): demo data for the art gallery view — mock mode and stories.
// Live entries come from the adapter (window/server/gallery.ts, T18); most of tonight's real
// art sits on agent branches until the Tech Lead merges, so the UI is built against this world.
// The "pixels" are generated SVG placeholders (deterministic per seed): fixtures carry no game art.
import type { ArtGalleryEntry } from "@fabric/contracts";

/** Deterministic placeholder pixels: a 4×4 two-tone checkerboard, distinct per seed. */
export const placeholderPixels = (seed: string): string => {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const square = (x: number, y: number, fill: string) => `<rect x="${x * 8}" y="${y * 8}" width="8" height="8" fill="${fill}"/>`;
  let body = "";
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const light = (x + y) % 2 === 0;
      body += square(x, y, light ? `hsl(${hue} 70% 62%)` : `hsl(${(hue + 40) % 360} 65% 34%)`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const entry = (
  asset: string, file: string, provider: string, verdict: "accepted" | "rejected",
  reason: string, gate: Record<string, number | boolean | null> | null, runId: string, minutesAgo: number,
): ArtGalleryEntry => ({
  asset,
  file: `gallery/${asset}/${file}`,
  url: placeholderPixels(`${asset}/${file}`),
  provider,
  verdict,
  reason,
  gate,
  runId,
  ts: new Date(Date.UTC(2026, 10, 8, 4, 30) - minutesAgo * 60_000).toISOString(),
});

const passGate = { uniqueColors: 24, paletteOk: true, outlinePixels: 3, snapOk: true, alphaRatio: 0.18, duplicates: 0 };
const failGate = { uniqueColors: 260, paletteOk: false, outlinePixels: 91, snapOk: false, alphaRatio: 0.02, duplicates: 4 };

/** Demo repos: names here are fixture-only; live repo names always come from the API. */
export const galleryRepos = ["demo-repo"];

export const galleryEntries: ArtGalleryEntry[] = [
  entry("sprite-hero", "pixellab-c1.png", "pixellab", "accepted", "On-palette, clean outline, snaps to the grid.", passGate, "run-a1", 12),
  entry("sprite-hero", "comfy-c2.png", "comfy", "rejected", "Palette drifted past the lock; outline ragged at 2×.", failGate, "run-a2", 26),
  entry("sprite-hero", "openai-c3.png", "openai", "accepted", "Matches the style sheet; grid-snap clean.", passGate, "run-a3", 41),
  entry("sprite-sidekick", "procedural-c1.png", "procedural", "accepted", "Fallback accepted after the paid passes missed the brief.", passGate, "run-b1", 58),
  entry("sprite-sidekick", "pixellab-c2.png", "pixellab", "rejected", "Silhouette reads as the hero at 1×; sent back.", failGate, "run-b2", 74),
  entry("tile-grass", "comfy-c1.png", "comfy", "accepted", "Seamless in both directions; palette locked.", passGate, "run-c1", 95),
  entry("tile-stone", "procedural-c1.png", "procedural", "accepted", "Deterministic variant of the base tile set.", passGate, "run-c2", 110),
  entry("ui-healthbar", "comfy-c1.png", "comfy", "accepted", "Nine-slice safe; contrast within range.", passGate, "run-d1", 130),
  entry("ui-healthbar", "openai-c2.png", "openai", "rejected", "Too many colors for the UI palette slot.", failGate, "run-d2", 145),
  entry("capsule-main", "pixellab-c1.png", "pixellab", "accepted", "Hero readable at 292 px; lockup centered.", passGate, "run-e1", 160),
  entry("capsule-main", "procedural-c2.png", "procedural", "rejected", "Text baked by the fallback is off-model.", failGate, "run-e2", 175),
  entry("sheet-pass-1", "contact.png", "procedural", "accepted", "Contact sheet from art pass 1 (no gate numbers).", null, "run-f1", 190),
];

export const galleryFixture = { repos: galleryRepos, entries: galleryEntries };
