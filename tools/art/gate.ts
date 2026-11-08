// Asset gate: checks a game repo's assets/manifest.json against the contract
// (docs/contracts/asset-manifest.md + asset.schema.json) without loading the game.
// Pure read-only analysis; returns a JSON-shaped report. The CLI turns `ok` into the exit code.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, type RgbaImage } from "./png.ts";
import { splitStrip } from "./ops.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_SCHEMA_PATH = path.join(ROOT, "docs", "contracts", "asset.schema.json");

export interface GateThresholds {
  /** Max fraction of pixels whose color is outside the locked palette (default 0: a lock leaves none). */
  maxOffPaletteShare?: number;
  /** Max fraction of differing pixels between consecutive frames (default 0.5). */
  maxFrameDrift?: number;
  /** Max fraction of differing pixels between the asset's frame 0 and its anchor's frame 0 (default 0.5). */
  maxAnchorDrift?: number;
  /** anchor_mode "style": max total-variation distance between the non-outline opaque-pixel color histograms of asset and anchor frame 0 (default 0.95). */
  maxPaletteDistance?: number;
  /** anchor_mode "style": max |luma range(asset) − luma range(anchor)|, ranges are p95−p5 of opaque-pixel luma in 0..1 (default 0.4). */
  maxLumaRangeDelta?: number;
  /** anchor_mode "style": min share of frame-0 edge pixels (opaque, 4-adjacent to transparent) in the outline color (default 0.8). */
  minOutlineShare?: number;
}

export const DEFAULT_THRESHOLDS: Required<GateThresholds> = {
  maxOffPaletteShare: 0,
  maxFrameDrift: 0.5,
  maxAnchorDrift: 0.5,
  maxPaletteDistance: 0.95,
  maxLumaRangeDelta: 0.4,
  minOutlineShare: 0.8,
};

/** How an asset is compared to its anchor: same subject (pixel drift) or same style, different subject (style metrics only). */
export type AnchorMode = "same-subject" | "style";

export interface GateOptions {
  schemaPath?: string;
  thresholds?: GateThresholds;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface AssetNumbers {
  offPaletteShare?: number;
  frameDrift?: number[];
  anchorDrift?: number | null;
  /** The drift basis used (null: anchor sheet, or the entry was refused for a missing anchor_mode). */
  anchorMode?: AnchorMode | null;
  /** Style mode only: the numbers style_similarity and style_outline gate on (frame 0 vs anchor frame 0). */
  paletteDistance?: number | null;
  lumaRange?: number | null;
  anchorLumaRange?: number | null;
  outlineColor?: string | null;
  outlineShare?: number | null;
}

export interface AssetResult {
  id: string;
  path: string;
  type: string;
  pass: boolean;
  checks: Check[];
  numbers: AssetNumbers;
}

export interface GateReport {
  ok: boolean;
  manifest: { valid: boolean; errors: string[] };
  files: { missing: string[]; unlisted: string[]; symlinks: string[] };
  assets: AssetResult[];
  thresholds: Required<GateThresholds>;
}

// ---------- minimal JSON Schema validator (exactly the features asset.schema.json uses) ----------

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const typeMatches = (v: unknown, t: string): boolean => {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number";
  return typeOf(v) === t;
};

/**
 * Validates against the subset of JSON Schema draft 2020-12 the contract uses:
 * type (incl. arrays and "integer"), const, enum, required, properties,
 * additionalProperties: false, items, minItems/maxItems, minLength/maxLength,
 * pattern, minimum/maximum/exclusiveMinimum/exclusiveMaximum. Returns one message per violation.
 */
const KNOWN_KEYWORDS: Record<string, true> = {
  type: true, const: true, enum: true, required: true, properties: true, additionalProperties: true, items: true,
  minItems: true, maxItems: true, minLength: true, maxLength: true, pattern: true, minimum: true, maximum: true,
  exclusiveMinimum: true, exclusiveMaximum: true, $schema: true, $id: true, title: true, description: true,
};

export function validateSchema(value: unknown, schema: unknown, at = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [`${at}: invalid schema node`];
  const s = schema as Record<string, unknown>;
  // The validator covers a fixed keyword set; an unknown keyword must fail loudly, not weaken the gate silently.
  for (const keyword of Object.keys(s))
    if (!KNOWN_KEYWORDS[keyword]) throw new Error(`validateSchema: unsupported keyword "${keyword}" at ${at} — extend the validator before trusting the gate`);
  const errors: string[] = [];

  if ("type" in s) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(value, t))) errors.push(`${at}: expected type ${types.join("|")}, got ${typeOf(value)}`);
  }
  if ("const" in s && value !== s.const) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if ("enum" in s) {
    const allowed = s.enum as unknown[];
    if (!allowed.some((e) => e === value)) errors.push(`${at}: must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) errors.push(`${at}: shorter than minLength ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) errors.push(`${at}: longer than maxLength ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value)) errors.push(`${at}: does not match pattern ${s.pattern}`);
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${at}: below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${at}: above maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) errors.push(`${at}: must be > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) errors.push(`${at}: must be < ${s.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${at}: fewer than minItems ${s.minItems}`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${at}: more than maxItems ${s.maxItems}`);
    if (s.items !== undefined) for (let i = 0; i < value.length; i++) errors.push(...validateSchema(value[i], s.items, `${at}[${i}]`));
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(s.required))
      for (const key of s.required as string[])
        if (!(key in value)) errors.push(`${at}: missing required property "${key}"`);
    for (const [key, sub] of Object.entries(props)) if (key in value) errors.push(...validateSchema((value as Record<string, unknown>)[key], sub, `${at}.${key}`));
    if (s.additionalProperties === false) {
      const known = new Set(Object.keys(props));
      for (const key of Object.keys(value as Record<string, unknown>))
        if (!known.has(key)) errors.push(`${at}: unexpected property "${key}"`);
    }
  }

  return errors;
}

// ---------- gate internals ----------

interface ManifestAsset {
  id: string;
  type: string;
  path: string;
  size?: { w: number; h: number };
  frames?: number;
  palette?: string[];
  anchor?: string | null;
  anchor_mode?: AnchorMode;
  outline?: string | null;
}

interface Manifest {
  grid: { w: number; h: number };
  palette: string[];
  outline?: string | null;
  assets: ManifestAsset[];
}

const pass = (name: string, detail?: string): Check => ({ name, pass: true, ...(detail ? { detail } : {}) });
const fail = (name: string, detail: string): Check => ({ name, pass: false, detail });

/** Repo-relative paths under <repo>/assets: regular files and symlinks, posix-style, sorted. */
function walkAssets(dir: string, prefix = "assets"): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  if (!existsSync(dir)) return { files, symlinks };
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = `${prefix}/${entry}`;
    const st = lstatSync(abs); // never follow links: a loop must not crash the gate
    if (st.isSymbolicLink()) symlinks.push(rel);
    else if (st.isDirectory()) {
      const nested = walkAssets(abs, rel);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else files.push(rel);
  }
  return { files, symlinks };
}

/** True when a manifest path normalizes to a real location under assets/ (no "..", no escape). */
export function assetPathIsSafe(p: string): boolean {
  const normalized = path.posix.normalize(p);
  return normalized.startsWith("assets/") && !normalized.split("/").includes("..");
}


function differingShare(a: RgbaImage, b: RgbaImage): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const n = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < n * 4; i += 4)
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) diff++;
  return diff / n;
}

// ---------- style metrics (subject-independent; anchor_mode "style") ----------

const hexOf = (d: Uint8Array, i: number) => `#${((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, "0")}`;

/** Color histogram (share of opaque pixels per color) and opaque-pixel lumas (0..1). */
function colorStats(img: RgbaImage): { hist: Map<string, number>; lumas: number[] } {
  const counts = new Map<string, number>();
  const lumas: number[] = [];
  for (let i = 0; i < img.width * img.height * 4; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const hex = hexOf(img.data, i);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
    lumas.push((0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255);
  }
  const hist = new Map<string, number>();
  for (const [hex, n] of counts) hist.set(hex, n / lumas.length);
  return { hist, lumas };
}

/** Opaque-pixel color histogram without `exclude` (the outline color), renormalized to sum 1. */
function interiorHist(img: RgbaImage, exclude: string | null): Map<string, number> {
  const hist = colorStats(img).hist;
  const ex = exclude?.toLowerCase();
  if (ex) hist.delete(ex);
  const total = [...hist.values()].reduce((x, y) => x + y, 0);
  for (const [hex, share] of hist) hist.set(hex, share / total);
  return hist;
}

/**
 * Total-variation distance of two color histograms: 0 = same color mix, 1 = no color in common.
 * `exclude` drops the outline color first: both images share it heavily, which would cap the
 * distance well below 1 whatever the interior is. null = no pixels left on one side.
 */
export function paletteDistance(a: RgbaImage, b: RgbaImage, exclude: string | null = null): number | null {
  const ha = interiorHist(a, exclude);
  const hb = interiorHist(b, exclude);
  if (ha.size === 0 || hb.size === 0) return null;
  let sum = 0;
  for (const hex of new Set([...ha.keys(), ...hb.keys()])) sum += Math.abs((ha.get(hex) ?? 0) - (hb.get(hex) ?? 0));
  return sum / 2;
}

/** p95 − p5 of opaque-pixel luma (0..1): the light/dark contrast span, robust to a stray pixel. */
export function lumaRange(img: RgbaImage): number | null {
  const lumas = colorStats(img).lumas.sort((x, y) => x - y);
  if (lumas.length === 0) return null;
  const at = (q: number) => lumas[Math.min(lumas.length - 1, Math.floor(q * lumas.length))];
  return at(0.95) - at(0.05);
}

/** Colors of the edge pixels: opaque pixels 4-adjacent to a transparent one (the frame border does not count). */
function edgeColors(img: RgbaImage): string[] {
  const out: string[] = [];
  const { width: w, height: h, data } = img;
  const clear = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] === 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) out.push(hexOf(data, i));
    }
  return out;
}

/** Share of edge pixels in `color` (0 when the image has no transparent edge at all). */
export function outlineShare(img: RgbaImage, color: string): number {
  const edge = edgeColors(img);
  const c = color.toLowerCase();
  return edge.length === 0 ? 0 : edge.filter((e) => e === c).length / edge.length;
}

/** The anchor's outline: its most common edge color and that color's share of the edge. */
export function dominantEdge(img: RgbaImage): { color: string; share: number } | null {
  const edge = edgeColors(img);
  if (edge.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of edge) counts.set(e, (counts.get(e) ?? 0) + 1);
  const [color, n] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return { color, share: n / edge.length };
}

export function runGate(repoDir: string, opts?: GateOptions): GateReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) };
  const manifestPath = path.join(repoDir, "assets", "manifest.json");
  const report: GateReport = {
    ok: false,
    manifest: { valid: false, errors: [] },
    files: { missing: [], unlisted: [], symlinks: [] },
    assets: [],
    thresholds,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    report.manifest.errors.push(`assets/manifest.json missing or unreadable: ${(e as Error).message}`);
    return report;
  }

  const schema = JSON.parse(readFileSync(opts?.schemaPath ?? DEFAULT_SCHEMA_PATH, "utf8"));
  const schemaErrors = validateSchema(parsed, schema);
  const manifest = parsed as Manifest;
  const ids = manifest.assets?.map((a) => a.id) ?? [];
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) schemaErrors.push(`assets: duplicate ids ${[...new Set(duplicates)].join(", ")}`);
  report.manifest.errors = schemaErrors;
  if (schemaErrors.length > 0) return report; // unreliable asset list; schema errors are the verdict
  report.manifest.valid = true;

  // File coverage: manifest paths exist (only paths that stay inside assets/ are probed);
  // every file under assets/ is listed (manifest.json itself exempt); symlinks are reported, not followed.
  const listed = new Set(manifest.assets.map((a) => a.path));
  const walked = walkAssets(path.join(repoDir, "assets"));
  const onDisk = walked.files.filter((p) => p !== "assets/manifest.json");
  report.files.symlinks = walked.symlinks.sort();
  report.files.missing = [...listed].filter((p) => assetPathIsSafe(p) && !existsSync(path.join(repoDir, p))).sort();
  report.files.unlisted = onDisk.filter((p) => !listed.has(p)).sort();

  const lockedSet = new Set(manifest.palette.map((hex) => hex.toLowerCase()));
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const decoded = new Map<string, RgbaImage | null>(); // path → image (null: not a decodable PNG asset)
  const decode = (asset: ManifestAsset): RgbaImage | null => {
    if (decoded.has(asset.path)) return decoded.get(asset.path)!;
    let img: RgbaImage | null = null;
    if (asset.path.endsWith(".png")) {
      try {
        img = decodePng(new Uint8Array(readFileSync(path.join(repoDir, asset.path))));
      } catch {
        img = null;
      }
    }
    decoded.set(asset.path, img);
    return img;
  };

  for (const asset of manifest.assets) {
    const checks: Check[] = [];
    const numbers: AssetNumbers = {};

    if (!assetPathIsSafe(asset.path)) {
      checks.push(fail("path_safe", `path "${asset.path}" does not stay under assets/`));
      report.assets.push({ id: asset.id, path: asset.path, type: asset.type, pass: false, checks, numbers });
      continue; // never read from (or satisfy the gate with) files outside the repo
    }

    const img = decode(asset);
    if (!img) {
      // PNG assets must decode; non-PNG (audio, ttf, …) are checked for existence only.
      checks.push(
        asset.path.endsWith(".png")
          ? fail("png", "file is not decodable as an 8-bit non-interlaced PNG")
          : pass("exists", "non-PNG asset: existence only"),
      );
      report.assets.push({ id: asset.id, path: asset.path, type: asset.type, pass: checks.every((c) => c.pass), checks, numbers });
      continue;
    }

    const frameCount = asset.frames ?? 1;
    checks.push(
      (asset.palette ?? []).every((hex) => lockedSet.has(hex.toLowerCase()))
        ? pass("palette_subset")
        : fail("palette_subset", `asset palette has colors outside the locked palette: ${(asset.palette ?? []).filter((hex) => !lockedSet.has(hex.toLowerCase())).join(", ")}`),
    );

    // A pixel matches iff fully transparent or fully opaque with an in-palette RGB.
    // The share is over opaque pixels: transparent ones cannot be off-palette.
    const total = img.width * img.height;
    let off = 0;
    let opaque = 0;
    const key = (r: number, g: number, b: number) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
    for (let i = 0; i < total; i++) {
      const a = img.data[i * 4 + 3];
      if (a === 0) continue;
      opaque++;
      if (a !== 255 || !lockedSet.has(key(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]))) off++;
    }
    numbers.offPaletteShare = opaque === 0 ? 0 : off / opaque;
    checks.push(
      numbers.offPaletteShare <= thresholds.maxOffPaletteShare
        ? pass("pixels_in_palette", `off-palette share ${numbers.offPaletteShare.toFixed(4)} of ${opaque} opaque px`)
        : fail("pixels_in_palette", `off-palette share ${numbers.offPaletteShare.toFixed(4)} of ${opaque} opaque px exceeds ${thresholds.maxOffPaletteShare}`),
    );

    // `size` is ONE frame (contract): the file is frames × size.w wide and size.h tall.
    checks.push(
      asset.size && img.width === asset.size.w * frameCount && img.height === asset.size.h
        ? pass("size", `declared frame ${asset.size.w}x${asset.size.h} × ${frameCount} = file ${img.width}x${img.height}`)
        : fail(
            "size",
            asset.size
              ? `declared frame ${asset.size.w}x${asset.size.h} × ${frameCount} frames = ${asset.size.w * frameCount}x${asset.size.h}, but the file is ${img.width}x${img.height}`
              : "PNG asset has no declared size",
          ),
    );

    // The grid multiple applies to the frame size, not the whole strip.
    const frameWidth = img.width / frameCount;
    checks.push(
      Number.isInteger(frameWidth) && frameWidth % manifest.grid.w === 0 && img.height % manifest.grid.h === 0
        ? pass("grid", `frame ${frameWidth}x${img.height} is a multiple of grid ${manifest.grid.w}x${manifest.grid.h}`)
        : fail("grid", `frame ${Number.isInteger(frameWidth) ? frameWidth : img.width / frameCount}x${img.height} is not a multiple of grid ${manifest.grid.w}x${manifest.grid.h}`),
    );

    if (asset.frames === undefined) {
      checks.push(pass("frames", "no frames declared; single frame"));
    } else {
      checks.push(
        img.width % asset.frames === 0
          ? pass("frames", `strip: ${img.width}px / ${asset.frames} frames = ${img.width / asset.frames}px each`)
          : fail("frames", `width ${img.width} does not divide into ${asset.frames} frames`),
      );
    }

    const anchorValid = !!asset.anchor && byId.has(asset.anchor) && asset.anchor !== asset.id;
    if (asset.anchor === null || asset.anchor === undefined) {
      checks.push(pass("anchor", "anchor sheet"));
    } else {
      const target = byId.get(asset.anchor);
      checks.push(
        target && target.id !== asset.id
          ? pass("anchor", `generated from "${asset.anchor}"`)
          : fail("anchor", target ? "anchor references itself" : `anchor "${asset.anchor}" is not a manifest id`),
      );
    }

    // The drift basis is declared, never guessed: a strip defaults to same-subject (its frames are one
    // subject); a single-frame asset with an anchor may be a different subject and must say which.
    let mode: AnchorMode | null = null;
    if (asset.anchor === null || asset.anchor === undefined) {
      if (asset.anchor_mode)
        checks.push(fail("anchor_mode", `anchor_mode "${asset.anchor_mode}" needs an anchor to compare against; anchor sheets (anchor: null) take none`));
    } else if (asset.anchor_mode) {
      mode = asset.anchor_mode;
      checks.push(pass("anchor_mode", `${mode} (declared)`));
    } else if (frameCount > 1) {
      mode = "same-subject";
      checks.push(pass("anchor_mode", "same-subject (default for strips)"));
    } else {
      checks.push(
        fail(
          "anchor_mode",
          `single-frame asset with anchor "${asset.anchor}" has no anchor_mode. Fix: set anchor_mode: "style" for cross-subject family members ` +
            `(a different subject in the anchor's style: palette, contrast and outline), "same-subject" for frames of one subject (pixel drift)`,
        ),
      );
    }
    numbers.anchorMode = mode;

    const divisible = img.width % frameCount === 0;
    const frames = divisible ? splitStrip(img, frameCount) : [img];
    const drifts: number[] = [];
    if (divisible)
      for (let f = 1; f < frames.length; f++) {
        const share = differingShare(frames[f - 1], frames[f]);
        if (share !== null) drifts.push(share);
      }
    numbers.frameDrift = drifts;
    const worstDrift = drifts.length > 0 ? Math.max(...drifts) : 0;
    checks.push(
      !divisible
        ? pass("frame_drift", "skipped: frame layout is invalid (see frames check)")
        : worstDrift <= thresholds.maxFrameDrift
          ? pass("frame_drift", `max consecutive-frame difference ${worstDrift.toFixed(4)} ≤ ${thresholds.maxFrameDrift}`)
          : fail("frame_drift", `max consecutive-frame difference ${worstDrift.toFixed(4)} exceeds ${thresholds.maxFrameDrift}`),
    );

    numbers.anchorDrift = null;
    if (anchorValid && mode === "style") {
      checks.push(pass("anchor_drift", "skipped: anchor_mode style (a different subject; style_similarity and style_outline gate instead)"));
      const anchorAsset = byId.get(asset.anchor!)!;
      const anchorImg = anchorAsset.path.endsWith(".png") ? decode(anchorAsset) : null;
      const anchorFrames = anchorAsset.frames ?? 1;
      const theirs = anchorImg && anchorImg.width % anchorFrames === 0 ? splitStrip(anchorImg, anchorFrames)[0] : null;
      const mine = frames[0];
      if (theirs === null) {
        checks.push(fail("style_similarity", `anchor "${asset.anchor}" is not a decodable PNG with a valid frame layout; nothing to compare the style against`));
      } else {
        // Outline color: the entry's, else the manifest's, else the anchor's own (its dominant edge color).
        let color: string | null;
        let source: string;
        if (asset.outline !== undefined) [color, source] = [asset.outline, "entry"];
        else if (manifest.outline !== undefined) [color, source] = [manifest.outline, "manifest"];
        else {
          const edge = dominantEdge(theirs);
          [color, source] = edge && edge.share >= thresholds.minOutlineShare ? [edge.color, `anchor edge, ${edge.share.toFixed(4)}`] : [null, "anchor has none"];
        }
        numbers.outlineColor = color;

        // The color mix is measured on non-outline pixels; the contrast span on all opaque pixels.
        const dist = paletteDistance(mine, theirs, color);
        const range = lumaRange(mine);
        const anchorRange = lumaRange(theirs);
        numbers.paletteDistance = dist;
        numbers.lumaRange = range;
        numbers.anchorLumaRange = anchorRange;
        if (range === null || anchorRange === null) {
          checks.push(fail("style_similarity", `${range === null ? "asset" : "anchor"} frame 0 has no opaque pixels`));
        } else if (dist === null) {
          checks.push(fail("style_similarity", `${paletteDistance(mine, mine, color) === null ? "asset" : "anchor"} frame 0 has no pixels besides the outline ${color}; no color mix to compare`));
        } else {
          const delta = Math.abs(range - anchorRange);
          const ok = dist <= thresholds.maxPaletteDistance && delta <= thresholds.maxLumaRangeDelta;
          const detail =
            `non-outline color-mix distance ${dist.toFixed(4)} (max ${thresholds.maxPaletteDistance}), ` +
            `luma range ${range.toFixed(4)} vs anchor ${anchorRange.toFixed(4)}, delta ${delta.toFixed(4)} (max ${thresholds.maxLumaRangeDelta})`;
          checks.push(ok ? pass("style_similarity", detail) : fail("style_similarity", detail));
        }

        if (color === null) {
          numbers.outlineShare = null;
          checks.push(pass("style_outline", `no outline expected (${source})`));
        } else {
          const share = outlineShare(mine, color);
          numbers.outlineShare = share;
          const detail = `${share.toFixed(4)} of frame-0 edge pixels are outline ${color.toLowerCase()} (${source}; min ${thresholds.minOutlineShare})`;
          checks.push(share >= thresholds.minOutlineShare ? pass("style_outline", detail) : fail("style_outline", detail));
        }
      }
    } else if (anchorValid && mode === "same-subject") {
      const anchorAsset = byId.get(asset.anchor!)!;
      const anchorImg = anchorAsset.path.endsWith(".png") ? decode(anchorAsset) : null;
      if (anchorImg) {
        const mine = frames[0];
        const anchorFrames = anchorAsset.frames ?? 1;
        const anchorDivisible = anchorImg.width % anchorFrames === 0;
        const theirs = anchorDivisible ? splitStrip(anchorImg, anchorFrames)[0] : null;
        const share = theirs === null ? null : differingShare(mine, theirs);
        if (theirs === null) {
          checks.push(pass("anchor_drift", `anchor frame layout is invalid; skipped`));
        } else if (share === null) {
          checks.push(pass("anchor_drift", `frame 0 is ${mine.width}x${mine.height}, anchor frame 0 is ${theirs.width}x${theirs.height}; sizes differ, skipped`));
        } else {
          numbers.anchorDrift = share;
          checks.push(
            share <= thresholds.maxAnchorDrift
              ? pass("anchor_drift", `frame 0 vs anchor frame 0 difference ${share.toFixed(4)} ≤ ${thresholds.maxAnchorDrift}`)
              : fail(
                  "anchor_drift",
                  `frame 0 vs anchor frame 0 difference ${share.toFixed(4)} exceeds ${thresholds.maxAnchorDrift}` +
                    (asset.anchor_mode ? "" : ` (anchor_mode defaulted to same-subject for a strip; set anchor_mode: "style" if this is a different subject)`),
                ),
          );
        }
      }
    }
    report.assets.push({ id: asset.id, path: asset.path, type: asset.type, pass: checks.every((c) => c.pass), checks, numbers });
  }

  report.ok =
    report.manifest.valid &&
    report.files.missing.length === 0 &&
    report.files.unlisted.length === 0 &&
    report.files.symlinks.length === 0 &&
    report.assets.every((a) => a.pass);
  return report;
}
