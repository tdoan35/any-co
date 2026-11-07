import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, makeImage, type RgbaImage } from "./png.ts";

// ---- independent PNG builder (test-side reimplementation, so the codec is checked
// against bytes it did not produce itself) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface BuiltPng {
  w: number;
  h: number;
  colorType: number; // 0 gray, 2 RGB, 3 indexed, 4 gray+alpha, 6 RGBA
  rows: Uint8Array[]; // each row: filter byte + filtered pixel bytes
  palette?: Uint8Array; // PLTE
  trns?: Uint8Array; // tRNS
  bitDepth?: number;
  interlace?: number;
}

function buildPng(o: BuiltPng): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, o.w);
  dv.setUint32(4, o.h);
  ihdr[8] = o.bitDepth ?? 8;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ?? 0;
  const parts: Uint8Array[] = [SIG, chunk("IHDR", ihdr)];
  if (o.palette) parts.push(chunk("PLTE", o.palette));
  if (o.trns) parts.push(chunk("tRNS", o.trns));
  const raw = new Uint8Array(o.rows.reduce((n, r) => n + r.length, 0));
  let at = 0;
  for (const r of o.rows) {
    raw.set(r, at);
    at += r.length;
  }
  parts.push(chunk("IDAT", new Uint8Array(deflateSync(raw))));
  parts.push(chunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Forward-filter one raw row the way a PNG encoder would (independent of png.ts). */
function filterRow(type: number, raw: Uint8Array, prev: Uint8Array | null, bpp: number): Uint8Array {
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const left = i >= bpp ? raw[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred: number;
    if (type === 0) pred = 0;
    else if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = Math.floor((left + up) / 2);
    else {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    out[i] = (raw[i] - pred) & 0xff;
  }
  return out;
}

function rowsFromRaw(raw: Uint8Array, h: number, stride: number, filterType: number, bpp: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  let prev: Uint8Array | null = null;
  for (let y = 0; y < h; y++) {
    const r = raw.subarray(y * stride, (y + 1) * stride);
    const f = filterRow(filterType, r, prev, bpp);
    prev = r;
    rows.push(Uint8Array.from([filterType, ...f]));
  }
  return rows;
}

/** Deterministic pseudo-random byte stream (LCG) for round-trip data. */
function lcg(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (1103515245 * s + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

// ---- codec ----

test("encode/decode round-trips an RGBA image byte-identically", () => {
  const w = 13;
  const h = 7;
  const img: RgbaImage = { width: w, height: h, data: lcg(42, w * h * 4) };
  const bytes = encodePng(img);
  assert.deepEqual(encodePng(img), bytes); // deterministic: same input → same bytes
  const back = decodePng(bytes);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(back.data, img.data);
});

test("makeImage returns a zeroed image", () => {
  const img = makeImage(3, 2);
  assert.equal(img.data.length, 24);
  assert.ok(img.data.every((b) => b === 0));
});

test("decodes RGB with a tRNS color key", () => {
  // 2x1: magenta key pixel, opaque green pixel
  const raw = Uint8Array.from([255, 0, 255, 0, 255, 0]);
  const png = buildPng({
    w: 2,
    h: 1,
    colorType: 2,
    rows: rowsFromRaw(raw, 1, 6, 0, 3),
    trns: Uint8Array.from([0, 255, 0, 255, 255]) /* gray unused + 6-byte RGB key: build below */,
  });
  // tRNS for colorType 2 is 6 bytes: R,G,B as 16-bit each. Rebuild correctly:
  const trns = new Uint8Array(6);
  trns[0] = 0; trns[1] = 255; // R = 255
  trns[2] = 0; trns[3] = 0; // G = 0
  trns[4] = 0; trns[5] = 255; // B = 255
  const png2 = buildPng({ w: 2, h: 1, colorType: 2, rows: rowsFromRaw(raw, 1, 6, 0, 3), trns });
  void png;
  const img = decodePng(png2);
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [255, 0, 255, 0]); // keyed → transparent
  assert.deepEqual(Array.from(img.data.slice(4, 8)), [0, 255, 0, 255]); // green opaque
});

test("decodes grayscale and grayscale+alpha", () => {
  const gray = decodePng(buildPng({ w: 2, h: 1, colorType: 0, rows: rowsFromRaw(Uint8Array.from([10, 200]), 1, 2, 0, 1) }));
  assert.deepEqual(Array.from(gray.data), [10, 10, 10, 255, 200, 200, 200, 255]);

  const ga = decodePng(buildPng({ w: 2, h: 1, colorType: 4, rows: rowsFromRaw(Uint8Array.from([10, 30, 200, 220]), 1, 4, 0, 2) }));
  assert.deepEqual(Array.from(ga.data), [10, 10, 10, 30, 200, 200, 200, 220]);
});

test("decodes indexed PNG with PLTE and tRNS", () => {
  const img = decodePng(
    buildPng({
      w: 3,
      h: 1,
      colorType: 3,
      rows: rowsFromRaw(Uint8Array.from([0, 1, 2]), 1, 3, 0, 1),
      palette: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), // 3 entries
      trns: Uint8Array.from([128]), // entry 0 semi-transparent, 1 and 2 default opaque
    }),
  );
  assert.deepEqual(Array.from(img.data), [1, 2, 3, 128, 4, 5, 6, 255, 7, 8, 9, 255]);
});

test("all five filter types reconstruct the same pixels", () => {
  const w = 5;
  const h = 4;
  const stride = w * 3;
  const raw = lcg(7, h * stride);
  for (const type of [0, 1, 2, 3, 4]) {
    const img = decodePng(buildPng({ w, h, colorType: 2, rows: rowsFromRaw(raw, h, stride, type, 3) }));
    const recon = new Uint8Array(h * stride);
    for (let p = 0; p < w * h; p++) {
      recon[p * 3] = img.data[p * 4];
      recon[p * 3 + 1] = img.data[p * 4 + 1];
      recon[p * 3 + 2] = img.data[p * 4 + 2];
    }
    assert.deepEqual(recon, raw, `filter type ${type}`);
  }
});

test("mixed filter types per row decode correctly", () => {
  const w = 4;
  const h = 3;
  const stride = w * 4;
  const raw = lcg(99, h * stride);
  const rows: Uint8Array[] = [];
  let prev: Uint8Array | null = null;
  for (let y = 0; y < h; y++) {
    const r = raw.subarray(y * stride, (y + 1) * stride);
    const type = y % 5;
    rows.push(Uint8Array.from([type, ...filterRow(type, r, prev, 4)]));
    prev = r;
  }
  const img = decodePng(buildPng({ w, h, colorType: 6, rows }));
  assert.deepEqual(img.data, raw);
});

test("rejects interlaced PNGs with a clear error", () => {
  const png = buildPng({ w: 1, h: 1, colorType: 6, rows: [Uint8Array.from([0, 1, 2, 3, 4])], interlace: 1 });
  assert.throws(() => decodePng(png), /interlac/i);
});

test("rejects 16-bit PNGs with a clear error", () => {
  const png = buildPng({ w: 1, h: 1, colorType: 6, rows: [Uint8Array.from([0, 1, 2, 3, 4])], bitDepth: 16 });
  assert.throws(() => decodePng(png), /16-bit|bit depth/i);
});

test("rejects bad signature, truncated data, CRC corruption, and unknown color type", () => {
  const good = buildPng({ w: 1, h: 1, colorType: 6, rows: [Uint8Array.from([0, 10, 20, 30, 40])] });
  const badSig = Uint8Array.from(good);
  badSig[3] = 0;
  assert.throws(() => decodePng(badSig), /signature/i);

  assert.throws(() => decodePng(good.subarray(0, good.length - 9)), /truncat|unexpected end|IEND/i);

  const badCrc = Uint8Array.from(good);
  badCrc[45] ^= 0xff; // inside IDAT data
  assert.throws(() => decodePng(badCrc), /crc/i);

  // unknown color type 5: patch IHDR's colorType byte and fix the chunk's CRC
  const patched = Uint8Array.from(good);
  patched[25] = 5; // absolute colorType offset: 8 (sig) + 4 (len) + 4 (type) + 8 (w+h) + 1 (bitDepth)
  const crc = crc32(patched.subarray(12, 29)); // type (12..15) + data (16..28)
  new DataView(patched.buffer).setUint32(29, crc);
  assert.throws(() => decodePng(patched), /color type/i);
});

test("rejects IDAT payload of the wrong size", () => {
  // claim 2x2 but supply 1x1 worth of pixels
  const png = buildPng({ w: 2, h: 2, colorType: 6, rows: [Uint8Array.from([0, 1, 2, 3, 4])] });
  assert.throws(() => decodePng(png), /size|length|bytes/i);
});

test("encoded PNG has the standard chunk structure", () => {
  const bytes = encodePng(makeImage(2, 2));
  const sig = bytes.subarray(0, 8);
  assert.deepEqual(sig, SIG);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len0 = dv.getUint32(8);
  const type0 = String.fromCharCode(...bytes.subarray(12, 16));
  assert.equal(type0, "IHDR");
  assert.equal(len0, 13);
  assert.equal(bytes[12 + 4 + 8], 8); // bit depth
  assert.equal(bytes[12 + 4 + 9], 6); // color type RGBA
  assert.equal(bytes[12 + 4 + 12], 0); // non-interlaced
  const tail = String.fromCharCode(...bytes.subarray(bytes.length - 8, bytes.length - 4));
  assert.equal(tail, "IEND");
});

test("rejects deflate bombs via the inflate output cap", () => {
  // 70 MB of zeros (~70 KB deflated) behind an IHDR claiming a huge RGBA image
  const raw = Buffer.alloc(70 * 1024 * 1024);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 4680);
  dv.setUint32(4, 3736); // expected inflated ≈ 70 MB > the 64 MB cap
  ihdr[8] = 8;
  ihdr[9] = 6;
  const bomb = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]);
  assert.throws(() => decodePng(bomb), /inflate/i);
});

test("the inflate cap comes from IHDR: a small image with an oversized IDAT stream is cut at height × (stride + 1)", () => {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 2);
  dv.setUint32(4, 2); // 2x2 RGBA: expected 2 × (8 + 1) = 18 bytes
  ihdr[8] = 8;
  ihdr[9] = 6;
  const oversized = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(Buffer.alloc(1024 * 1024)))), chunk("IEND", new Uint8Array(0))]);
  assert.throws(() => decodePng(oversized), /inflate/i);
});
