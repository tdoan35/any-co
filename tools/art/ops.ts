// Deterministic image operations for the art pipeline (T2).
// Pure functions on RGBA images: same input → byte-identical output. Inputs are never mutated.

import type { RgbaImage } from "./png.ts";
import { makeImage } from "./png.ts";

export function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`color must be #rrggbb, got "${hex}"`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Björn Ottosson's OKLab: the gate's and the lock's perceptual distance space. */
export function toOklab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export interface LockStats {
  pixelsChanged: number;
  /** Largest OKLab distance between an opaque pixel and its locked palette entry (0 when all match). */
  maxDistance: number;
}

/**
 * Binarize alpha at `alphaThreshold` (default 128) and snap every opaque pixel to the
 * nearest palette color by OKLab distance. Distance ties go to the earlier palette entry.
 * Transparent pixels become (0,0,0,0).
 */
export function lockPalette(
  img: RgbaImage,
  palette: string[],
  opts?: { alphaThreshold?: number },
): { image: RgbaImage; stats: LockStats } {
  if (palette.length === 0) throw new Error("lockPalette: palette must not be empty");
  const threshold = opts?.alphaThreshold ?? 128;
  const entries = palette.map((hex) => parseHex(hex));
  const labs = entries.map(([r, g, b]) => toOklab(r, g, b));

  const out = makeImage(img.width, img.height);
  const src = img.data;
  const dst = out.data;
  let pixelsChanged = 0;
  let maxSq = 0;

  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (src[o + 3] < threshold) {
      dst[o] = 0;
      dst[o + 1] = 0;
      dst[o + 2] = 0;
      dst[o + 3] = 0;
    } else {
      const lab = toOklab(src[o], src[o + 1], src[o + 2]);
      let best = 0;
      let bestSq = Infinity;
      for (let p = 0; p < labs.length; p++) {
        const dl = lab[0] - labs[p][0];
        const da = lab[1] - labs[p][1];
        const db = lab[2] - labs[p][2];
        const sq = dl * dl + da * da + db * db;
        if (sq < bestSq) {
          bestSq = sq;
          best = p;
        }
      }
      if (bestSq > maxSq) maxSq = bestSq;
      dst[o] = entries[best][0];
      dst[o + 1] = entries[best][1];
      dst[o + 2] = entries[best][2];
      dst[o + 3] = 255;
    }
    if (dst[o] !== src[o] || dst[o + 1] !== src[o + 1] || dst[o + 2] !== src[o + 2] || dst[o + 3] !== src[o + 3])
      pixelsChanged++;
  }
  return { image: out, stats: { pixelsChanged, maxDistance: Math.sqrt(maxSq) } };
}

export interface SnapResult {
  image: RgbaImage;
  scaleX: number;
  scaleY: number;
  uniform: boolean;
  integerScale: boolean;
}

/**
 * Downscale an (upscaled) render to exactly w×h. Each target cell takes its most frequent
 * exact RGBA color; transparent (0,0,0,0) votes like any other color. Count ties go to the
 * lexicographically smallest (r,g,b,a) tuple. Cell bounds are proportional, so non-integer
 * and non-uniform scales work.
 */
export function snapToGrid(img: RgbaImage, opts: { w: number; h: number }): SnapResult {
  const { w, h } = opts;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0)
    throw new Error(`snapToGrid: target must be positive integers, got ${w}x${h}`);
  if (img.width < w || img.height < h)
    throw new Error(`snapToGrid: source ${img.width}x${img.height} is smaller than the target ${w}x${h}`);

  const out = makeImage(w, h);
  for (let cy = 0; cy < h; cy++) {
    const y0 = Math.floor((cy * img.height) / h);
    const y1 = Math.floor(((cy + 1) * img.height) / h);
    for (let cx = 0; cx < w; cx++) {
      const x0 = Math.floor((cx * img.width) / w);
      const x1 = Math.floor(((cx + 1) * img.width) / w);
      const counts = new Map<number, number>();
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * img.width + x) * 4;
          const key = (img.data[o] << 24) | (img.data[o + 1] << 16) | (img.data[o + 2] << 8) | img.data[o + 3];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      let bestKey = 0;
      let bestCount = -1;
      let bestTuple: [number, number, number, number] = [256, 256, 256, 256];
      for (const [key, count] of counts) {
        const tuple: [number, number, number, number] = [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255];
        const lexicographicallySmaller =
          tuple[0] < bestTuple[0] ||
          (tuple[0] === bestTuple[0] && (tuple[1] < bestTuple[1] ||
            (tuple[1] === bestTuple[1] && (tuple[2] < bestTuple[2] ||
              (tuple[2] === bestTuple[2] && tuple[3] < bestTuple[3])))));
        if (count > bestCount || (count === bestCount && lexicographicallySmaller)) {
          bestCount = count;
          bestKey = key;
          bestTuple = tuple;
        }
      }
      const o = (cy * w + cx) * 4;
      out.data[o] = (bestKey >>> 24) & 255;
      out.data[o + 1] = (bestKey >>> 16) & 255;
      out.data[o + 2] = (bestKey >>> 8) & 255;
      out.data[o + 3] = bestKey & 255;
    }
  }
  const scaleX = img.width / w;
  const scaleY = img.height / h;
  return { image: out, scaleX, scaleY, uniform: scaleX === scaleY, integerScale: Number.isInteger(scaleX) && Number.isInteger(scaleY) };
}

/** 1 px outline in `color` on transparent pixels 4-adjacent to opaque (alpha ≠ 0) pixels. */
export function addOutline(img: RgbaImage, color: string, opts?: { mode?: "outer" }): RgbaImage {
  const mode = opts?.mode ?? "outer";
  if (mode !== "outer") throw new Error(`addOutline: unsupported mode "${mode}" (only "outer")`);
  const [r, g, b] = parseHex(color);
  const src = img.data;
  const out = makeImage(img.width, img.height);
  out.data.set(src);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (src[o + 3] !== 0) continue; // only transparent pixels get the outline
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
        if (src[(ny * img.width + nx) * 4 + 3] !== 0) {
          out.data[o] = r;
          out.data[o + 1] = g;
          out.data[o + 2] = b;
          out.data[o + 3] = 255;
          break;
        }
      }
    }
  }
  return out;
}

export interface SheetCell {
  /** Index into the caller's original frames array. */
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Frames side by side in one row at an integer `scale` with `gap` transparent pixels between
 * cells. `anchor` (an original index, default 0) is placed first; the sidecar maps each cell
 * rectangle back to its original frame index. All frames must share one size. No text.
 */
export function contactSheet(
  frames: RgbaImage[],
  opts?: { anchor?: number; scale?: number; gap?: number },
): { image: RgbaImage; cells: SheetCell[] } {
  if (frames.length === 0) throw new Error("contactSheet: need at least one frame");
  const anchor = opts?.anchor ?? 0;
  const scale = opts?.scale ?? 1;
  const gap = opts?.gap ?? 0;
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`contactSheet: scale must be an integer >= 1, got ${scale}`);
  if (!Number.isInteger(gap) || gap < 0) throw new Error(`contactSheet: gap must be an integer >= 0, got ${gap}`);
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= frames.length)
    throw new Error(`contactSheet: anchor ${anchor} is not a frame index (0..${frames.length - 1})`);
  const fw = frames[0].width;
  const fh = frames[0].height;
  if (frames.some((f) => f.width !== fw || f.height !== fh))
    throw new Error("contactSheet: all frames must have the same size");

  const order = [anchor, ...frames.map((_, i) => i).filter((i) => i !== anchor)];
  const n = order.length;
  const out = makeImage(n * fw * scale + (n - 1) * gap, fh * scale);
  const cells: SheetCell[] = order.map((frame, cell) => ({
    frame,
    x: cell * (fw * scale + gap),
    y: 0,
    w: fw * scale,
    h: fh * scale,
  }));
  order.forEach((frameIdx, cell) => {
    const src = frames[frameIdx];
    const x0 = cell * (fw * scale + gap);
    for (let y = 0; y < fh * scale; y++) {
      for (let x = 0; x < fw * scale; x++) {
        const s = (Math.floor(y / scale) * fw + Math.floor(x / scale)) * 4;
        const d = (y * out.width + x0 + x) * 4;
        out.data[d] = src.data[s];
        out.data[d + 1] = src.data[s + 1];
        out.data[d + 2] = src.data[s + 2];
        out.data[d + 3] = src.data[s + 3];
      }
    }
  });
  return { image: out, cells };
}

/** Split a horizontal frame strip into `frames` equal images. */
export function splitStrip(img: RgbaImage, frames: number): RgbaImage[] {
  if (!Number.isInteger(frames) || frames < 1) throw new Error(`splitStrip: frames must be an integer >= 1, got ${frames}`);
  if (img.width % frames !== 0)
    throw new Error(`splitStrip: width ${img.width} is not divisible by ${frames} frames`);
  const fw = img.width / frames;
  const out: RgbaImage[] = [];
  for (let f = 0; f < frames; f++) {
    const frame = makeImage(fw, img.height);
    for (let y = 0; y < img.height; y++) {
      const s = (y * img.width + f * fw) * 4;
      frame.data.set(img.data.subarray(s, s + fw * 4), y * fw * 4);
    }
    out.push(frame);
  }
  return out;
}

/** Nearest-neighbour integer upscale, pixel-art style: each pixel becomes a k×k block (art_view). */
export function upscaleNearest(img: RgbaImage, k: number): RgbaImage {
  if (!Number.isInteger(k) || k < 1) throw new Error(`upscale factor must be a positive integer, got ${k}`);
  const out = makeImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < out.width; x++) {
      const si = (sy * img.width + ((x / k) | 0)) * 4;
      out.data.set(img.data.subarray(si, si + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}
