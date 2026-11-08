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
import type { Balance, ProviderName } from "./generate.ts";

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

/** A comfy generation (T41b): no balance, the lane that served it, so the lanes can be compared. Never feeds the low notes. */
export interface LocalLine { ts: string; provider: "comfy"; unit: "local"; lane: string; images: number; batch: number | null; run_id: string; source: "generation" }

export function recordLocalGeneration(file: string, line: LocalLine): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Per-lane comfy totals from the credits log (calls, images), for comparing lanes. */
export function comfyLaneStats(file: string): Record<string, { calls: number; images: number }> {
  const out: Record<string, { calls: number; images: number }> = {};
  if (!existsSync(file)) return out;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    try {
      const line = JSON.parse(l) as Partial<LocalLine>;
      if (line.unit !== "local" || typeof line.lane !== "string") continue;
      const s = (out[line.lane] ??= { calls: 0, images: 0 });
      s.calls++;
      s.images += line.images ?? 0;
    } catch {
      /* torn line */
    }
  }
  return out;
}

export function readCredits(file: string): CreditLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      const line = JSON.parse(l) as CreditLine | LocalLine;
      return line.unit === "local" ? [] : [line as CreditLine]; // balance readers never see comfy lines
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

/** A human-approved redo (T39): the asset's allowance restarts at the count it had when granted. */
export interface RedoGrant { ts: string; by: string; why: string; at_count: number; at_comfy_count?: number; approval?: string }

export interface Gallery {
  anchors: Record<string, { provider: ProviderName; ts: string; run_id: string; why?: string }>;
  generations: Record<string, number>;
  redos?: Record<string, RedoGrant[]>;
  /** Free/local comfy generations per asset (T39c): their own counter, so free churn never eats the paid allowance. */
  comfy_generations?: Record<string, number>;
}
/** Asset/anchor key: the game-repo path ("game/assets/x.png" and "assets/x.png" are one asset). */
export const assetKey = (rel: string) => path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\/)?game\//, "");

export const readGallery = (file: string): Gallery => {
  const g = readJson<Partial<Gallery>>(file, {});
  return { anchors: g.anchors ?? {}, generations: g.generations ?? {}, redos: g.redos ?? {}, comfy_generations: g.comfy_generations ?? {} };
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

/** Which per-asset counter a call uses (T39c): paid providers (pixellab, retrodiffusion) or the free local comfy lab. */
export type GenCounter = "paid" | "comfy";

/** Default comfy allowance per out path: 1 + 6. Free, but still capped so one asset can't churn forever. */
export const COMFY_REGEN_CAP_DEFAULT = 7;

/** COMFY_REGEN_CAP (total comfy generations per out path, ≥ 1), default 7; a malformed value is an error. */
export function comfyRegenCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.COMFY_REGEN_CAP?.trim();
  if (!raw) return COMFY_REGEN_CAP_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`COMFY_REGEN_CAP must be an integer from 1 to 100 (total comfy generations per out path), got "${raw}"`);
  return n;
}

/** The cap for a counter: paid 1 + MAX_REGENERATIONS; comfy COMFY_REGEN_CAP. */
export const capFor = (kind: GenCounter, env: Record<string, string | undefined> = process.env) => (kind === "paid" ? 1 + MAX_REGENERATIONS : comfyRegenCap(env));
export const counterFor = (provider: ProviderName): GenCounter => (provider === "comfy" ? "comfy" : "paid");

const countsOf = (g: Gallery, kind: GenCounter): Record<string, number> => (kind === "paid" ? g.generations : (g.comfy_generations ??= {}));
const baseOf = (g: Gallery, k: string, kind: GenCounter) => {
  const last = g.redos?.[k]?.at(-1);
  return (kind === "paid" ? last?.at_count : last?.at_comfy_count) ?? 0;
};

/** Generations this asset has used on a counter since its last human redo grant (or ever). */
export function generationsUsedSinceRedo(file: string, out: string, kind: GenCounter = "paid"): number {
  const g = readGallery(file);
  const k = assetKey(out);
  return (countsOf(g, kind)[k] ?? 0) - baseOf(g, k, kind);
}

/**
 * Take one generation slot BEFORE the call (T39). Check and count happen in one synchronous step, so two in-flight
 * calls in this process cannot both pass a cap they jointly exceed (the "4 of 3" seen on Nov 7). `kind` picks the
 * counter (T39c). Returns the slot (1-based within the current allowance) or null when that cap is reached.
 */
export function reserveGeneration(file: string, out: string, kind: GenCounter = "paid", cap = capFor(kind)): { slot: number; total: number; kind: GenCounter; cap: number } | null {
  const g = readGallery(file);
  const k = assetKey(out);
  const counts = countsOf(g, kind);
  const used = (counts[k] ?? 0) - baseOf(g, k, kind);
  if (used >= cap) return null;
  counts[k] = (counts[k] ?? 0) + 1;
  writeAtomic(file, g);
  return { slot: used + 1, total: counts[k], kind, cap };
}

/** Give a reserved slot back: the call billed nothing (refused, exhausted, unavailable, floored, procedural). */
export function releaseGeneration(file: string, out: string, kind: GenCounter = "paid"): void {
  const g = readGallery(file);
  const k = assetKey(out);
  const counts = countsOf(g, kind);
  if ((counts[k] ?? 0) > 0) counts[k] -= 1;
  if (counts[k] === 0) delete counts[k];
  writeAtomic(file, g);
}

/** Record a human-approved redo: the asset gets a fresh 1 + MAX_REGENERATIONS allowance. Only an operator path calls this. */
export function grantRedo(file: string, out: string, info: { by: string; why: string; approval?: string }, now = new Date()): RedoGrant {
  const g = readGallery(file);
  const k = assetKey(out);
  const grant: RedoGrant = { ts: now.toISOString(), by: info.by, why: info.why, at_count: g.generations[k] ?? 0, at_comfy_count: g.comfy_generations?.[k] ?? 0, ...(info.approval ? { approval: info.approval } : {}) };
  g.redos = g.redos ?? {};
  g.redos[k] = [...(g.redos[k] ?? []), grant];
  writeAtomic(file, g);
  return grant;
}

// ---------- pre-call validation (T39): refuse a paid call that cannot produce a usable asset ----------

/** The out path's problem, or null: a real `<name>.png` basename (no ".png", no hidden file) under the clone's assets/. */
export function outPathProblem(out: string): string | null {
  const norm = path.posix.normalize(out.replace(/\\/g, "/")).replace(/^\.\//, "");
  const base = path.posix.basename(norm);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.png$/i.test(base) || base.toLowerCase() === ".png")
    return `out "${out}" has no file name. Fix: out must end in <name>.png, e.g. game/assets/sprites/hero.png (letters, digits, _ . -; no spaces). Retrying the same out is refused the same way`;
  if (!norm.startsWith("game/assets/"))
    return `out "${out}" is not under the game clone's assets/ (want game/assets/<path>.png): only manifest-listed assets are generated`;
  return null;
}


// ---------- PixelLab floor (T35): one shared generations balance across studios, enforced in code ----------

/** Generations a pixellab call is assumed to use when none has been measured yet (animations ran 10-30). */
export const PIXELLAB_DEFAULT_CALL_ESTIMATE = 30;

/** PIXELLAB_MIN_REMAINING as a non-negative integer, or null when unset/empty. A malformed value throws (a floor must not silently vanish). */
export function pixellabFloor(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PIXELLAB_MIN_REMAINING?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`PIXELLAB_MIN_REMAINING must be a non-negative integer (generations), got "${raw}"`);
  return n;
}

/** The per-call estimate: the most generations one pixellab call has used (credits log, T21), else the default. */
export function pixellabCallEstimate(creditsFile: string): number {
  const used = readCredits(creditsFile)
    .filter((c) => c.provider === "pixellab" && typeof c.generations_used === "number" && c.generations_used > 0)
    .map((c) => c.generations_used as number);
  return used.length ? Math.ceil(Math.max(...used)) : PIXELLAB_DEFAULT_CALL_ESTIMATE;
}

export interface FloorVerdict {
  blocked: boolean;
  floor: number;
  remaining: number | null;
  estimate: number;
  /** "at_floor" (remaining <= floor), "would_cross" (remaining - estimate < floor), "unreadable" (no generations balance: fail closed), or "ok". */
  reason: "at_floor" | "would_cross" | "unreadable" | "ok";
  message: string;
}

/**
 * The rule: refuse a pixellab call when remaining <= floor, or when remaining - estimate < floor (the call itself
 * would cross it). An unreadable balance fails closed while a floor is set. A USD (credits, not subscription)
 * balance is outside a generations floor and passes.
 */
export function checkPixellabFloor(bal: Balance | null, floor: number, estimate: number): FloorVerdict {
  const base = { floor, estimate, remaining: bal?.remaining ?? null };
  const stop = "use provider comfy with your reference image, or stop and report";
  if (bal === null || !Number.isFinite(bal.remaining))
    return { ...base, blocked: true, reason: "unreadable", message: `PixelLab floor ${floor} is set but the balance could not be read (fails closed): ${stop}` };
  if (bal.unit !== "generations") return { ...base, blocked: false, reason: "ok", message: `balance is ${bal.unit}, not generations: the generations floor does not apply` };
  if (bal.remaining <= floor)
    return { ...base, blocked: true, reason: "at_floor", message: `PixelLab floor reached (remaining ${bal.remaining} <= ${floor}): ${stop}` };
  if (bal.remaining - estimate < floor)
    return { ...base, blocked: true, reason: "would_cross", message: `PixelLab floor reached (remaining ${bal.remaining} - up to ${estimate} for this call < ${floor}): ${stop}` };
  return { ...base, blocked: false, reason: "ok", message: `remaining ${bal.remaining}, floor ${floor}, call estimate ${estimate}` };
}
