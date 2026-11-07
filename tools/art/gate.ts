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
}

export const DEFAULT_THRESHOLDS: Required<GateThresholds> = {
  maxOffPaletteShare: 0,
  maxFrameDrift: 0.5,
  maxAnchorDrift: 0.5,
};

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
 * pattern, minimum/maximum/exclusiveMinimum. Returns one message per violation.
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
}

interface Manifest {
  grid: { w: number; h: number };
  palette: string[];
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
    if (asset.anchor && byId.has(asset.anchor) && asset.anchor !== asset.id) {
      const anchorAsset = byId.get(asset.anchor)!;
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
              : fail("anchor_drift", `frame 0 vs anchor frame 0 difference ${share.toFixed(4)} exceeds ${thresholds.maxAnchorDrift}`),
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
