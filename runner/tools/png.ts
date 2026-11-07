// Minimal PNG codec for art_view: decode to RGBA, nearest-neighbour upscale, encode RGBA.
// Pure node:zlib — no image library (repo rule: deterministic code for mechanical jobs).
// Supports 8-bit non-interlaced PNGs: gray (0), RGB (2), palette (3, tRNS optional),
// gray+alpha (4), RGBA (6). Anything else is refused with a clear error.
import { deflateSync, inflateSync, crc32 } from "node:zlib";

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}

function readChunks(buf: Buffer) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG (bad signature)");
  const chunks: Array<{ type: string; body: Buffer }> = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (body.length < len || off + 12 + len > buf.length) throw new Error("truncated PNG chunk");
    const expect = buf.readUInt32BE(off + 8 + len);
    if ((crc32(Buffer.concat([buf.subarray(off + 4, off + 8), body])) >>> 0) !== expect) {
      throw new Error(`PNG chunk ${type} failed its CRC check`);
    }
    chunks.push({ type, body });
    off += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Paeth predictor for PNG filter type 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Rgba {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.body.length < 13) throw new Error("PNG has no IHDR");
  const width = ihdr.body.readUInt32BE(0);
  const height = ihdr.body.readUInt32BE(4);
  const depth = ihdr.body[8];
  const color = ihdr.body[9];
  const interlace = ihdr.body[12];
  if (width <= 0 || height <= 0) throw new Error(`degenerate PNG size ${width}x${height}`);
  if (width * height > 16_777_216) throw new Error(`PNG is too large to decode: ${width}x${height} (cap 16M pixels)`); // inflate bomb guard
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth} (only 8)`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${color}`);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.body));
  let raw: Buffer;
  try {
    raw = inflateSync(idat);
  } catch (e) {
    throw new Error(`PNG image data does not inflate: ${e instanceof Error ? e.message : String(e)}`);
  }
  const bpr = width * channels; // bytes per row before filtering
  if (raw.length < (bpr + 1) * height) throw new Error("PNG image data is shorter than the header says");
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(bpr);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (bpr + 1)];
    const src = raw.subarray(y * (bpr + 1) + 1, y * (bpr + 1) + 1 + bpr);
    const cur = new Uint8Array(bpr);
    for (let i = 0; i < bpr; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      cur[i] = filter === 0 ? src[i] : filter === 1 ? src[i] + a : filter === 2 ? src[i] + b : filter === 3 ? src[i] + ((a + b) >> 1) : src[i] + paeth(a, b, c);
    }
    rows.push(cur);
    prev = cur;
  }
  const plte = chunks.find((c) => c.type === "PLTE")?.body;
  const trns = chunks.find((c) => c.type === "tRNS")?.body;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = x * channels; // index into rows[y]
      const di = (y * width + x) * 4;
      if (color === 0) {
        data[di] = data[di + 1] = data[di + 2] = rows[y][si];
        data[di + 3] = 255;
      } else if (color === 2) {
        data[di] = rows[y][si];
        data[di + 1] = rows[y][si + 1];
        data[di + 2] = rows[y][si + 2];
        data[di + 3] = 255;
      } else if (color === 3) {
        const idx = rows[y][si] * 3;
        if (!plte || idx + 2 >= plte.length + 1) throw new Error("palette index outside PLTE");
        data[di] = plte[idx];
        data[di + 1] = plte[idx + 1];
        data[di + 2] = plte[idx + 2];
        data[di + 3] = trns && rows[y][si] < trns.length ? trns[rows[y][si]] : 255;
      } else if (color === 4) {
        data[di] = data[di + 1] = data[di + 2] = rows[y][si];
        data[di + 3] = rows[y][si + 1];
      } else {
        data[di] = rows[y][si];
        data[di + 1] = rows[y][si + 1];
        data[di + 2] = rows[y][si + 2];
        data[di + 3] = rows[y][si + 3];
      }
    }
  }
  return { width, height, data };
}

/** Encode RGBA as an 8-bit RGBA PNG (filter 0 rows). */
export function encodePng(img: Rgba): Buffer {
  if (img.width <= 0 || img.height <= 0 || img.data.length < img.width * img.height * 4) throw new Error("degenerate RGBA image");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width * 4 + 1)] = 0; // filter: none
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(raw, y * (img.width * 4 + 1) + 1);
  }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Nearest-neighbour integer upscale, pixel art style: each pixel becomes a k×k block. */
export function upscaleNearest(img: Rgba, k: number): Rgba {
  if (!Number.isInteger(k) || k < 1) throw new Error(`upscale factor must be a positive integer, got ${k}`);
  const width = img.width * k;
  const height = img.height * k;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < width; x++) {
      const sx = (x / k) | 0;
      const si = (sy * img.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = img.data[si];
      data[di + 1] = img.data[si + 1];
      data[di + 2] = img.data[si + 2];
      data[di + 3] = img.data[si + 3];
    }
  }
  return { width, height, data };
}
