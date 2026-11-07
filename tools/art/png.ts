// PNG codec in pure TypeScript on node:zlib (T2: no new npm dependencies).
// Decode: 8-bit RGBA, RGB, grayscale(+alpha), indexed (PLTE + tRNS), all five
// filter types, non-interlaced only. Encode: 8-bit RGBA, filter type 0.

import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. Length is width * height * 4. */
  readonly data: Uint8Array;
}

export class PngError extends Error {}

export function makeImage(width: number, height: number): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new PngError(`invalid image size ${width}x${height}`);
  return { width, height, data: new Uint8Array(width * height * 4) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// colorType → samples per pixel (8-bit each)
const BPP: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b))
    throw new PngError("not a PNG: bad signature");

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let ihdr: Ihdr | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];
  let sawIend = false;

  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new PngError("truncated PNG: unexpected end of file inside a chunk header");
    const length = dv.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + length > bytes.length) throw new PngError(`truncated PNG: ${type} chunk overruns the file`);
    const data = bytes.subarray(at + 8, at + 8 + length);
    const crc = dv.getUint32(at + 8 + length);
    if (crc !== crc32(bytes.subarray(at + 4, at + 8 + length))) throw new PngError(`${type} chunk failed CRC check`);
    if (type === "IHDR") {
      if (ihdr || at !== 8) throw new PngError("IHDR must be the first chunk and appear once");
      if (length !== 13) throw new PngError(`IHDR has length ${length}, expected 13`);
      ihdr = {
        width: dv.getUint32(at + 8),
        height: dv.getUint32(at + 12),
        bitDepth: bytes[at + 16],
        colorType: bytes[at + 17],
        interlace: bytes[at + 20],
      };
      const compression = bytes[at + 18];
      const filterMethod = bytes[at + 19];
      if (compression !== 0) throw new PngError(`unsupported compression method ${compression}`);
      if (filterMethod !== 0) throw new PngError(`unsupported filter method ${filterMethod}`);
    } else if (type === "PLTE") {
      if (plte) throw new PngError("duplicate PLTE chunk");
      plte = data;
    } else if (type === "tRNS") {
      if (trns) throw new PngError("duplicate tRNS chunk");
      trns = data;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      sawIend = true;
    }
    at += 12 + length;
  }

  if (!ihdr) throw new PngError("PNG has no IHDR chunk");
  if (!sawIend) throw new PngError("truncated PNG: no IEND chunk");
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8)
    throw new PngError(`unsupported bit depth ${bitDepth}: only 8-bit PNGs are supported (got ${bitDepth}-bit)`);
  const bpp = BPP[colorType];
  if (bpp === undefined) throw new PngError(`unsupported color type ${colorType}`);
  if (interlace !== 0) throw new PngError("interlaced PNGs (Adam7) are not supported");
  if (width <= 0 || height <= 0) throw new PngError(`invalid image size ${width}x${height}`);
  if (colorType === 3 && (!plte || plte.length === 0 || plte.length % 3 !== 0))
    throw new PngError("indexed PNG has no valid PLTE chunk");

  let inflated: Uint8Array;
  try {
    const joined = new Uint8Array(idats.reduce((n, d) => n + d.length, 0));
    let off = 0;
    for (const d of idats) {
      joined.set(d, off);
      off += d.length;
    }
    inflated = new Uint8Array(inflateSync(joined));
  } catch (e) {
    throw new PngError(`IDAT stream failed to inflate: ${(e as Error).message}`);
  }

  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (inflated.length !== expected)
    throw new PngError(`decoded pixel data has the wrong size: got ${inflated.length} bytes, expected ${expected}`);

  // Unfilter (all five types). Output: raw samples per row, no filter bytes.
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const lineStart = y * (stride + 1);
    const filter = inflated[lineStart];
    const rowStart = y * stride;
    const prevRow = y > 0 ? rowStart - stride : -1;
    for (let i = 0; i < stride; i++) {
      const x = inflated[lineStart + 1 + i];
      const left = i >= bpp ? raw[rowStart + i - bpp] : 0;
      const up = prevRow >= 0 ? raw[prevRow + i] : 0;
      const upLeft = prevRow >= 0 && i >= bpp ? raw[prevRow + i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          v = x + pred;
          break;
        }
        default:
          throw new PngError(`unsupported filter type ${filter} on row ${y}`);
      }
      raw[rowStart + i] = v & 0xff;
    }
  }

  const img = makeImage(width, height);
  const out = img.data;
  const o = 4; // bytes per output pixel
  if (colorType === 6) {
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = raw[i * 4];
      out[i * 4 + 1] = raw[i * 4 + 1];
      out[i * 4 + 2] = raw[i * 4 + 2];
      out[i * 4 + 3] = raw[i * 4 + 3];
    }
  } else if (colorType === 2) {
    // optional tRNS color key: 6 bytes = R,G,B as 16-bit each
    let keyR = -1;
    let keyG = -1;
    let keyB = -1;
    if (trns && trns.length >= 6) {
      const t = new DataView(trns.buffer, trns.byteOffset, trns.byteLength);
      keyR = t.getUint16(0);
      keyG = t.getUint16(2);
      keyB = t.getUint16(4);
    }
    for (let i = 0; i < width * height; i++) {
      const r = raw[i * 3];
      const g = raw[i * 3 + 1];
      const b = raw[i * 3 + 2];
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
    }
  } else if (colorType === 0) {
    let key = -1;
    if (trns && trns.length >= 2) {
      key = new DataView(trns.buffer, trns.byteOffset, trns.byteLength).getUint16(0);
    }
    for (let i = 0; i < width * height; i++) {
      const g = raw[i];
      out[i * 4] = g;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = g;
      out[i * 4 + 3] = g === key ? 0 : 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < width * height; i++) {
      const g = raw[i * 2];
      out[i * 4] = g;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = g;
      out[i * 4 + 3] = raw[i * 2 + 1];
    }
  } else {
    // indexed
    const pal = plte!;
    const entries = pal.length / 3;
    for (let i = 0; i < width * height; i++) {
      const idx = raw[i];
      if (idx >= entries) throw new PngError(`palette index ${idx} out of range (PLTE has ${entries} entries)`);
      out[i * 4] = pal[idx * 3];
      out[i * 4 + 1] = pal[idx * 3 + 1];
      out[i * 4 + 2] = pal[idx * 3 + 2];
      out[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return img;
}

export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) throw new PngError(`data length ${data.length} does not match ${width}x${height} RGBA`);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[12] = 0; // non-interlaced

  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));

  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };

  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const outBytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    outBytes.set(p, at);
    at += p.length;
  }
  return outBytes;
}
