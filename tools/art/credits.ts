// Credit-aware art generation state (T19). The providers run on free-trial tiers and nobody
// buys more credits, so the harness tracks what is left and routes around what is gone:
//   runs/art-providers.json  provider → {exhausted, ts, remaining_balance}; set on an out-of-balance
//                            answer, cleared only by a human (`npm run art -- providers --clear <p>`)
//   runs/art-credits.jsonl   one line per balance the providers report (ts, provider, remaining, run_id)
//   runs/art-gallery.json    anchor → winning provider (bake-off result), asset → generation count
// All writes are atomic (temp + rename) except the append-only credits log. Paths are overridable
// by env (ART_PROVIDERS_FILE, ART_CREDITS_FILE, ART_GALLERY_FILE) and default under runsDir.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderName } from "./generate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The paid (credit-tracked) providers; comfy is local and never exhausted. */
export const PROVIDERS: ProviderName[] = ["retrodiffusion", "pixellab"];
/** The one fallback for a provider that is exhausted or unavailable: comfy and retrodiffusion → pixellab, pixellab → retrodiffusion. */
export const other = (p: ProviderName): ProviderName => (p === "pixellab" ? "retrodiffusion" : "pixellab");

/** Regenerations allowed per asset after its first generation (a 4th paid call is refused). */
export const MAX_REGENERATIONS = 2;
/** A usd balance is "low" below this share of the first usd reading that day. */
export const LOW_SHARE = 0.2;
/** A generations balance (PixelLab subscription) is "low" at or below this many remaining. */
export const LOW_GENERATIONS = 400;

export interface ArtStatePaths { providers: string; credits: string; gallery: string }
export function statePaths(runsDir?: string, env: Record<string, string | undefined> = process.env): ArtStatePaths {
  const dir = runsDir ?? path.join(ROOT, "runs");
  return {
    providers: env.ART_PROVIDERS_FILE ?? path.join(dir, "art-providers.json"),
    credits: env.ART_CREDITS_FILE ?? path.join(dir, "art-credits.jsonl"),
    gallery: env.ART_GALLERY_FILE ?? path.join(dir, "art-gallery.json"),
  };
}

function readJson<T>(file: string, empty: T): T {
  if (!existsSync(file)) return empty;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return empty;
  }
}
function writeAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

// ---------- exhausted providers ----------

export interface ProviderState { exhausted: boolean; ts: string; remaining_balance: number | null; reason?: string }
export type ProvidersFile = Partial<Record<ProviderName, ProviderState>>;

export const readProviders = (file: string): ProvidersFile => readJson<ProvidersFile>(file, {});
export const isExhausted = (file: string, p: ProviderName) => readProviders(file)[p]?.exhausted === true;

export function markExhausted(file: string, p: ProviderName, info: { remaining_balance?: number | null; reason: string }, now = new Date()) {
  const s = readProviders(file);
  s[p] = { exhausted: true, ts: now.toISOString(), remaining_balance: info.remaining_balance ?? null, reason: info.reason };
  writeAtomic(file, s);
}

/** Human-only: clear one provider's exhausted flag (after credits came back). */
export function clearProvider(file: string, p: ProviderName): ProvidersFile {
  const s = readProviders(file);
  delete s[p];
  writeAtomic(file, s);
  return s;
}

// ---------- credits log + low-balance notes ----------

export type CreditUnit = "usd" | "generations";
export interface CreditLine {
  ts: string;
  provider: ProviderName;
  remaining: number;
  /** "generations" for a PixelLab subscription, else "usd". Lines written before T21 have no unit (usd). */
  unit?: CreditUnit;
  total?: number | null;
  generations_used?: number | null;
  run_id: string;
  source: string;
}

export function readCredits(file: string): CreditLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as CreditLine];
    } catch {
      return [];
    }
  });
}

export interface LowNote { provider: ProviderName; threshold: "low20" | "low400" | "zero"; unit: CreditUnit; day: string; remaining: number; first_today: number; ref: string }

/**
 * Append one reported balance. Returns the low-balance thresholds this line crosses that have
 * not been noted yet today (the caller writes ONE ledger note each; `alreadyNoted` checks refs).
 */
export function recordCredit(file: string, line: CreditLine, alreadyNoted: (ref: string) => boolean): LowNote[] {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n");
  const day = line.ts.slice(0, 10);
  const unit: CreditUnit = line.unit ?? "usd";
  const today = readCredits(file).filter((c) => c.provider === line.provider && c.ts.slice(0, 10) === day && (c.unit ?? "usd") === unit);
  const first = today[0]?.remaining ?? line.remaining;
  const notes: LowNote[] = [];
  const crossed: Array<LowNote["threshold"]> = [];
  if (line.remaining <= 0) crossed.push("zero");
  if (unit === "generations" ? line.remaining <= LOW_GENERATIONS : first > 0 && line.remaining < first * LOW_SHARE)
    crossed.push(unit === "generations" ? "low400" : "low20");
  for (const threshold of crossed) {
    const ref = `art-credits:${line.provider}:${day}:${threshold}`;
    if (!alreadyNoted(ref)) notes.push({ provider: line.provider, threshold, unit, day, remaining: line.remaining, first_today: first, ref });
  }
  return notes;
}

// ---------- gallery index: anchor winners, regeneration counts ----------

export interface Gallery {
  anchors: Record<string, { provider: ProviderName; ts: string; run_id: string; why?: string }>;
  generations: Record<string, number>;
}
/** Asset/anchor key: the game-repo path ("game/assets/x.png" and "assets/x.png" are one asset). */
export const assetKey = (rel: string) => path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\/)?game\//, "");

export const readGallery = (file: string): Gallery => {
  const g = readJson<Partial<Gallery>>(file, {});
  return { anchors: g.anchors ?? {}, generations: g.generations ?? {} };
};

export function recordAnchorWinner(file: string, anchor: string, provider: ProviderName, run_id: string, why?: string, now = new Date()) {
  const g = readGallery(file);
  g.anchors[assetKey(anchor)] = { provider, ts: now.toISOString(), run_id, ...(why ? { why } : {}) };
  writeAtomic(file, g);
}

export const anchorWinner = (file: string, reference: string) => readGallery(file).anchors[assetKey(reference)]?.provider;

/** Paid generations so far for an asset (1 = the first, 2–3 = regenerations). */
export const generationCount = (file: string, out: string) => readGallery(file).generations[assetKey(out)] ?? 0;

export function countGeneration(file: string, out: string): number {
  const g = readGallery(file);
  const k = assetKey(out);
  g.generations[k] = (g.generations[k] ?? 0) + 1;
  writeAtomic(file, g);
  return g.generations[k];
}
