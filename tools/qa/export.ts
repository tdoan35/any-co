// Release gate on the EXPORTED build (T26). The other QA layers run the project directory; this one
// checks exactly what ships, so a pack that is missing its scripts can't pass because the project
// dir still has them. Two layers, per pack (dist/web/index.pck, and dist/windows/*.pck when present):
//   1. pack table (deterministic, no engine): parse the .pck directory and require every autoload
//      that project.godot [autoload] names (as .gd, .gdc, or .gd.remap / .tscn.remap).
//   2. native run: `godot --main-pack <pck>` in an empty temp dir (no project.godot, so nothing but
//      the pack loads), Godot movie mode (--write-movie, docs/decisions.md engine spike: it renders
//      where --headless doesn't) for N fixed-fps frames, then the LAST frame must not be blank:
//      non-background share ≥ 5% on the whole frame AND the central half, and ≥ 8 unique colours.
//      The pack's qa/ capture scenes are excluded from exports, so the screenshot contract's
//      `screenshot` command isn't available here; the movie writer is the engine's own capture of
//      the frame a player sees, which is what screenshot.md asks for. A non-zero exit, no frames,
//      or the engine's load-failure lines (missing scene/script) fail too.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodePng, type RgbaImage } from "../art/png.ts";
import { track } from "../proc/reaper.ts";
import type { Check } from "./invariants.ts";

// ---------- pack table ----------

export interface PckInfo { version: number; engine: string; files: string[] }

const PACK_DIR_ENCRYPTED = 1;

/** Read a Godot .pck directory (pack format 1–4). Paths are returned without "res://". */
export function readPck(buf: Uint8Array): PckInfo {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 0x60 || b.toString("latin1", 0, 4) !== "GDPC") throw new Error("not a Godot pack (no GDPC magic)");
  const version = b.readUInt32LE(4);
  const engine = `${b.readUInt32LE(8)}.${b.readUInt32LE(12)}.${b.readUInt32LE(16)}`;
  if (version < 1 || version > 4) throw new Error(`unsupported pack format version ${version} (engine ${engine})`);
  let o = 20;
  let flags = 0;
  if (version >= 2) {
    flags = b.readUInt32LE(o);
    o += 4 + 8; // flags, file_base
  }
  if (flags & PACK_DIR_ENCRYPTED) throw new Error("pack directory is encrypted: the file table can't be checked");
  if (version >= 3) {
    const dirOffset = Number(b.readBigUInt64LE(o));
    if (dirOffset <= 0 || dirOffset >= b.length) throw new Error(`pack directory offset ${dirOffset} is outside the file`);
    o = dirOffset;
  } else o += 16 * 4; // reserved
  const count = b.readUInt32LE(o);
  o += 4;
  if (count > 1_000_000) throw new Error(`implausible file count ${count}`);
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = b.readUInt32LE(o);
    o += 4;
    if (o + len > b.length) throw new Error(`pack directory entry ${i} runs past the end of the file`);
    files.push(b.toString("utf8", o, o + len).replace(/\0+$/, "").replace(/^res:\/\//, ""));
    o += len + 8 + 8 + 16 + (version >= 2 ? 4 : 0); // offset, size, md5, flags
  }
  return { version, engine, files };
}

/** project.godot [autoload] entries: name → res:// path (a leading "*" marks a singleton). */
export function parseAutoloads(projectGodot: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  let inSection = false;
  for (const raw of projectGodot.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inSection = line === "[autoload]";
      continue;
    }
    const m = inSection && line.match(/^([A-Za-z_][\w]*)\s*=\s*"\*?(res:\/\/[^"]+)"/);
    if (m) out.push({ name: m[1], path: m[2] });
  }
  return out;
}

/** Each autoload must ship: the file itself, its compiled .gdc, or the export's .remap for it. */
export function missingAutoloads(autoloads: Array<{ name: string; path: string }>, files: string[]): string[] {
  const have = new Set(files);
  return autoloads
    .filter(({ path: p }) => {
      const rel = p.replace(/^res:\/\//, "");
      const candidates = [rel, `${rel}.remap`, rel.replace(/\.gd$/, ".gdc")];
      return !candidates.some((c) => have.has(c));
    })
    .map((a) => `${a.name} (${a.path})`);
}

// ---------- frame blankness ----------

export interface RegionStats { pixels: number; nonBackgroundShare: number; uniqueColors: number; background: string }
export interface FrameStats { width: number; height: number; whole: RegionStats; center: RegionStats }
export const BLANK_DEFAULTS = { minNonBackground: 0.05, minUniqueColors: 8 };

function region(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): RegionStats {
  const counts = new Map<number, number>();
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]; // alpha ignored: what the player sees
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  const pixels = (x1 - x0) * (y1 - y0);
  let bg = 0;
  let bgCount = 0;
  for (const [k, c] of counts) if (c > bgCount) [bg, bgCount] = [k, c];
  return { pixels, nonBackgroundShare: pixels ? Math.round((1 - bgCount / pixels) * 10_000) / 10_000 : 0, uniqueColors: counts.size, background: `#${bg.toString(16).padStart(6, "0")}` };
}

/** Background = the most common colour of the region; the central region is the middle half each way. */
export function frameStats(img: RgbaImage): FrameStats {
  const { width: w, height: h } = img;
  return { width: w, height: h, whole: region(img, 0, 0, w, h), center: region(img, Math.floor(w / 4), Math.floor(h / 4), Math.ceil((3 * w) / 4), Math.ceil((3 * h) / 4)) };
}

export function blankIssues(s: FrameStats, t = BLANK_DEFAULTS): string[] {
  const issues: string[] = [];
  for (const [name, r] of [["whole frame", s.whole], ["central region", s.center]] as const)
    if (r.nonBackgroundShare < t.minNonBackground) issues.push(`${name}: ${(r.nonBackgroundShare * 100).toFixed(2)}% non-background (< ${t.minNonBackground * 100}%)`);
  if (s.whole.uniqueColors < t.minUniqueColors) issues.push(`only ${s.whole.uniqueColors} unique colours (< ${t.minUniqueColors})`);
  return issues;
}

// ---------- native run of a pack ----------

export interface PackRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  frames: number;
  lastFrame: string | null;
  /** Every rendered frame, in order (absolute paths in the run dir). */
  framePaths: string[];
  loadErrors: string[];
  outputTail: string;
}

/** Engine lines that mean shipped content failed to load (not warnings). */
const LOAD_FAILURE = /Failed loading (?:scene|resource)|Failed to load script|Can't load script|Parse Error|Cannot open file|Couldn't load file|No main scene|Error loading main scene/i;

export async function runPack(pck: string, opts: { frames?: number; fps?: number; timeoutMs?: number; godot?: string; keepDir?: string } = {}): Promise<PackRun> {
  const frames = opts.frames ?? 90;
  const dir = opts.keepDir ?? mkdtempSync(path.join(tmpdir(), "qa-export-"));
  const framesDir = path.join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const godot = opts.godot ?? process.env.GODOT_BIN ?? "godot";
  // cwd = an empty dir: no project.godot, so the engine loads the pack and nothing else
  const argv = ["--main-pack", path.resolve(pck), "--write-movie", path.join(framesDir, "frame.png"), "--fixed-fps", String(opts.fps ?? 30), "--quit-after", String(frames)];
  const child = spawn(godot, argv, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const reaper = child.pid ? track(child.pid) : null;
  let out = "";
  const take = (d: Buffer) => (out = (out + String(d)).slice(-200_000));
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  let timedOut = false;
  const end = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, opts.timeoutMs ?? 120_000);
    child.once("error", (e) => {
      clearTimeout(timer);
      out += `\nspawn error: ${e.message}`;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group gone */ }
  reaper?.untrack();
  const pngs = readdirSync(framesDir).filter((f) => /^frame\d+\.png$/.test(f)).sort();
  const loadErrors = out.split("\n").filter((l) => LOAD_FAILURE.test(l)).slice(0, 10).map((l) => l.trim());
  const run: PackRun = {
    exitCode: end.code, signal: end.signal, timedOut, frames: pngs.length,
    lastFrame: pngs.length ? path.join(framesDir, pngs.at(-1)!) : null, framePaths: pngs.map((f) => path.join(framesDir, f)), loadErrors, outputTail: out.slice(-1500),
  };
  if (!opts.keepDir && !run.lastFrame) rmSync(dir, { recursive: true, force: true });
  return run;
}

// ---------- the gate ----------

export interface PackReport {
  pck: string;
  engine?: string;
  pack_format?: number;
  files?: number;
  autoloads: string[];
  missing_autoloads: string[];
  run?: Omit<PackRun, "outputTail" | "lastFrame" | "framePaths"> & { last_frame: string | null; stats?: FrameStats; saved_frames?: string[] };
}
export interface ExportCheckResult { ok: boolean; exitCode: 0 | 1 | 2; checks: Check[]; packs: PackReport[]; error?: string }
export interface ExportCheckOptions {
  gameDir: string; distDir?: string; frames?: number; timeoutMs?: number; run?: boolean; godot?: string; thresholds?: typeof BLANK_DEFAULTS;
  /** Copy this many evenly spaced frames (always including the last) into saveDir/<pack>/ (UI review of the exported build). */
  saveFrames?: number;
  saveDir?: string;
}

/** `count` frame indices out of `n`, evenly spaced, ascending, always ending at the last frame. */
export function pickFrames(n: number, count: number): number[] {
  if (n <= 0 || count <= 0) return [];
  const k = Math.min(n, Math.floor(count));
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round(((i + 1) * n) / k) - 1))].sort((a, b) => a - b);
}

/** The packs a release ships: dist/web/index.pck (required) and any dist/windows/*.pck. */
export function shippedPacks(distDir: string): string[] {
  const packs = [path.join(distDir, "web", "index.pck")];
  const win = path.join(distDir, "windows");
  if (existsSync(win)) for (const f of readdirSync(win).sort()) if (f.endsWith(".pck")) packs.push(path.join(win, f));
  return packs;
}

export async function exportCheck(o: ExportCheckOptions): Promise<ExportCheckResult> {
  const checks: Check[] = [];
  const packs: PackReport[] = [];
  try {
    const projectFile = path.join(o.gameDir, "project.godot");
    if (!existsSync(projectFile)) return { ok: false, exitCode: 2, checks, packs, error: `no project.godot in ${o.gameDir}` };
    const autoloads = parseAutoloads(readFileSync(projectFile, "utf8"));
    const dist = o.distDir ?? path.join(o.gameDir, "dist");
    for (const pck of shippedPacks(dist)) {
      const rel = path.relative(dist, pck);
      const report: PackReport = { pck: rel, autoloads: autoloads.map((a) => `${a.name}=${a.path}`), missing_autoloads: [] };
      packs.push(report);
      if (!existsSync(pck)) {
        checks.push({ name: `${rel}: exists`, pass: false, detail: `${pck} is missing (run build.sh build-web first)` });
        continue;
      }
      let info: PckInfo;
      try {
        info = readPck(new Uint8Array(readFileSync(pck)));
      } catch (e) {
        checks.push({ name: `${rel}: pack table`, pass: false, detail: (e as Error).message });
        continue;
      }
      Object.assign(report, { engine: info.engine, pack_format: info.version, files: info.files.length });
      report.missing_autoloads = missingAutoloads(autoloads, info.files);
      checks.push({
        name: `${rel}: autoloads shipped`,
        pass: report.missing_autoloads.length === 0,
        detail: report.missing_autoloads.length
          ? `missing from the pack: ${report.missing_autoloads.join(", ")} (check export_presets.cfg exclude_filter)`
          : `${autoloads.length} autoload(s) present among ${info.files.length} files`,
      });
      if (o.run === false) continue;
      const run = await runPack(pck, { frames: o.frames, timeoutMs: o.timeoutMs, godot: o.godot });
      const stats = run.lastFrame ? frameStats(decodePng(new Uint8Array(readFileSync(run.lastFrame)))) : undefined;
      report.run = { exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, frames: run.frames, loadErrors: run.loadErrors, last_frame: run.lastFrame, ...(stats ? { stats } : {}) };
      if (o.saveFrames && o.saveDir && run.framePaths.length) {
        const dest = path.join(o.saveDir, rel.replace(/\.pck$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-"));
        mkdirSync(dest, { recursive: true });
        report.run.saved_frames = pickFrames(run.framePaths.length, o.saveFrames).map((i) => {
          const to = path.join(dest, `frame-${String(i).padStart(4, "0")}.png`);
          copyFileSync(run.framePaths[i], to);
          return to;
        });
      }
      const runIssues = [
        ...(run.timedOut ? ["timed out"] : []),
        ...(run.exitCode !== 0 ? [`engine exit ${run.exitCode}${run.signal ? ` (${run.signal})` : ""}`] : []),
        ...(run.frames === 0 ? ["no frames rendered"] : []),
        ...run.loadErrors.slice(0, 3),
      ];
      checks.push({ name: `${rel}: runs natively`, pass: runIssues.length === 0, detail: runIssues.length ? runIssues.join("; ") : `exit 0, ${run.frames} frames` });
      if (stats) {
        const blank = blankIssues(stats, o.thresholds);
        checks.push({
          name: `${rel}: last frame not blank`,
          pass: blank.length === 0,
          detail: `${stats.width}x${stats.height}: whole ${(stats.whole.nonBackgroundShare * 100).toFixed(1)}% non-bg, ${stats.whole.uniqueColors} colours; centre ${(stats.center.nonBackgroundShare * 100).toFixed(1)}%${blank.length ? ` — ${blank.join("; ")}` : ""}`,
        });
      }
    }
    const ok = checks.length > 0 && checks.every((c) => c.pass);
    return { ok, exitCode: ok ? 0 : 1, checks, packs };
  } catch (e) {
    return { ok: false, exitCode: 2, checks, packs, error: e instanceof Error ? e.message : String(e) };
  }
}
