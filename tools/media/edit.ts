// Deterministic video edits with ffmpeg (argv only, no shell). The marketing agent writes the
// edit plan (clips, order, durations, output); this module only executes and checks it.
//
// Pipeline: every clip is normalized to one lossless intermediate (PNG-in-Matroska, RGB, same
// size and fps, nearest-neighbour scaling so pixel art stays crisp, letterboxed to the output
// aspect), the segments are concatenated, then encoded once: H.264 yuv420p mp4, or GIF via
// palettegen/paletteuse (no dithering). Outputs over max_bytes are deleted and fail loudly.
import { execFile, execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const FFMPEG = () => process.env.FFMPEG_BIN ?? "ffmpeg";
export const FFPROBE = () => process.env.FFPROBE_BIN ?? "ffprobe";

export function hasFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG(), ["-version"], { stdio: "ignore", timeout: 10_000 });
    execFileSync(FFPROBE(), ["-version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const Clip = z.union([
  z.object({ source: z.string().min(1).describe("video file"), start_s: z.number().min(0), end_s: z.number().positive() }).strict(),
  z.object({ still: z.string().min(1).describe("PNG (title card or screenshot)"), duration_s: z.number().positive().max(30) }).strict(),
]);
export const EditPlan = z
  .object({
    schema_version: z.literal(1),
    clips: z.array(Clip).min(1).max(60).describe("Played in this order"),
    output: z
      .object({
        path: z.string().min(1),
        format: z.enum(["mp4", "gif"]),
        width: z.number().int().min(16).max(3840),
        height: z.number().int().min(16).max(2160),
        fps: z.number().int().min(1).max(60),
        max_bytes: z.number().int().positive().optional(),
        max_duration_s: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.clips.forEach((c, i) => {
      if ("source" in c && c.end_s <= c.start_s) ctx.addIssue({ code: "custom", path: ["clips", i, "end_s"], message: "end_s must be after start_s" });
    });
    if (p.output.format === "mp4" && (p.output.width % 2 || p.output.height % 2))
      ctx.addIssue({ code: "custom", path: ["output"], message: "mp4 (yuv420p) needs an even width and height" });
  });
export type EditPlan = z.infer<typeof EditPlan>;

export function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${path.basename(bin)} failed: ${String(stderr).trim().split("\n").slice(-4).join(" | ") || err.message}`)) : resolve(String(stdout)),
    ),
  );
}

// Input hardening (review R16-4): ffmpeg picks a demuxer from file content, so an agent-written
// "clip.mp4" that is really an HLS/concat playlist could pull media from outside the workspace.
// Every input runs with `-protocol_whitelist file`, playlists are refused by their header before
// any ffmpeg/ffprobe opens them, and each clip's demuxer is pinned to an allowlisted container.
const SAFE_FILES = ["-protocol_whitelist", "file"];
const CONTAINERS = new Set(["mov", "avi", "matroska", "gif", "apng"]);

/** Refuse playlist/manifest/concat text files by their first bytes (they reference other files). */
export function assertNotPlaylist(file: string): void {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(256);
  const n = readSync(fd, buf, 0, 256, 0);
  closeSync(fd);
  const head = buf.subarray(0, n).toString("latin1").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (/^(#extm3u|ffconcat|file\s+'|<\?xml|<mpd|\[playlist\]|#extinf)/.test(head))
    throw new Error(`${path.basename(file)} is a playlist/manifest, not media; refused (it could reference files outside the workspace)`);
}

export interface ProbeSummary {
  format: string;
  duration_s: number;
  size_bytes: number;
  video: { codec: string; width: number; height: number; fps: number; pix_fmt: string; frames: number | null } | null;
  audio: boolean;
}

/** ffprobe summary of one media file. */
export async function probe(file: string, timeoutMs = 30_000): Promise<ProbeSummary> {
  assertNotPlaylist(file);
  const j = JSON.parse(await run(FFPROBE(), ["-v", "error", ...SAFE_FILES, "-print_format", "json", "-show_format", "-show_streams", file], timeoutMs));
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
  const rate = (r?: string) => {
    const [a, b] = String(r ?? "0/1").split("/").map(Number);
    return b ? Math.round((a / b) * 1000) / 1000 : 0;
  };
  const format = String(j.format?.format_name ?? "");
  if (/(^|,)(hls|applehttp|concat|dash|tee|playlist)(,|$)/.test(format)) throw new Error(`${path.basename(file)} probes as ${format}, a playlist format; refused`);
  return {
    format,
    duration_s: Number(j.format?.duration ?? v?.duration ?? 0),
    size_bytes: Number(j.format?.size ?? statSync(file).size),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: rate(v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate), pix_fmt: v.pix_fmt, frames: v.nb_frames ? Number(v.nb_frames) : null } : null,
    audio: (j.streams ?? []).some((s: any) => s.codec_type === "audio"),
  };
}

export interface EditOptions {
  resolveInput: (rel: string) => string; // confinement is the caller's: returns an absolute path or throws
  resolveOutput: (rel: string) => string;
  timeoutMs?: number;
}

export interface EditResult { out: string; bytes: number; duration_s: number; clips: number; probe: ProbeSummary }

/** Execute an edit plan. Throws with a precise reason on any invalid clip or cap breach. */
export async function edit(planInput: unknown, o: EditOptions): Promise<EditResult> {
  const plan = EditPlan.parse(planInput);
  const timeoutMs = o.timeoutMs ?? 300_000;
  const { width: W, height: H, fps } = plan.output;
  const vf = `fps=${fps},scale=${W}:${H}:flags=neighbor:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24`;
  const out = o.resolveOutput(plan.output.path);
  const ext = path.extname(out).toLowerCase();
  if (ext !== `.${plan.output.format}`) throw new Error(`output.path must end in .${plan.output.format}, got "${plan.output.path}"`);

  let total = 0;
  const inputs = plan.clips.map((c) => ("source" in c ? { ...c, abs: o.resolveInput(c.source) } : { ...c, abs: o.resolveInput(c.still) }));
  for (const [i, c] of inputs.entries()) {
    if (!existsSync(c.abs)) throw new Error(`clips[${i}]: ${"source" in c ? c.source : c.still} does not exist`);
    if ("source" in c) {
      const p = await probe(c.abs, timeoutMs);
      if (!p.video) throw new Error(`clips[${i}]: ${c.source} has no video stream`);
      const demuxer = p.format.split(",")[0];
      if (!CONTAINERS.has(demuxer)) throw new Error(`clips[${i}]: ${c.source} is ${p.format}; allowed containers are mp4/mov, avi, mkv/webm, gif, apng`);
      (c as { demuxer?: string }).demuxer = demuxer;
      if (c.end_s > p.duration_s + 0.05) throw new Error(`clips[${i}]: end_s ${c.end_s} is past the end of ${c.source} (${p.duration_s.toFixed(3)} s)`);
      total += c.end_s - c.start_s;
    } else {
      if (!/\.png$/i.test(c.still)) throw new Error(`clips[${i}]: still must be a .png, got "${c.still}"`);
      assertNotPlaylist(c.abs);
      const sig = Buffer.alloc(8);
      const fd = openSync(c.abs, "r");
      readSync(fd, sig, 0, 8, 0);
      closeSync(fd);
      if (sig.toString("hex") !== "89504e470d0a1a0a") throw new Error(`clips[${i}]: ${c.still} is not a PNG file`);
      total += c.duration_s;
    }
  }
  if (plan.output.max_duration_s !== undefined && total > plan.output.max_duration_s + 1e-6)
    throw new Error(`the plan runs ${total.toFixed(3)} s, over output.max_duration_s ${plan.output.max_duration_s}`);

  const tmp = mkdtempSync(path.join(tmpdir(), "media-edit-"));
  try {
    const segs: string[] = [];
    for (const [i, c] of inputs.entries()) {
      const seg = path.join(tmp, `seg-${String(i).padStart(3, "0")}.mkv`);
      const input = "source" in c
        ? [...SAFE_FILES, "-f", String((c as { demuxer?: string }).demuxer), "-ss", String(c.start_s), "-t", String(c.end_s - c.start_s), "-i", c.abs]
        : [...SAFE_FILES, "-f", "image2", "-c:v", "png", "-loop", "1", "-framerate", String(fps), "-t", String(c.duration_s), "-i", c.abs];
      await run(FFMPEG(), ["-y", "-v", "error", ...input, "-an", "-vf", vf, "-c:v", "png", "-f", "matroska", seg], timeoutMs);
      segs.push(seg);
    }
    const list = path.join(tmp, "concat.txt");
    writeFileSync(list, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const joined = path.join(tmp, "joined.mkv");
    await run(FFMPEG(), ["-y", "-v", "error", ...SAFE_FILES, "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined], timeoutMs); // our own list of our own temp segments

    const staged = path.join(tmp, `out${ext}`);
    const common = ["-map_metadata", "-1", "-fflags", "+bitexact", "-an"];
    if (plan.output.format === "mp4")
      await run(FFMPEG(), ["-y", "-v", "error", ...SAFE_FILES, "-f", "matroska", "-i", joined, ...common, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-flags:v", "+bitexact", "-movflags", "+faststart", staged], timeoutMs);
    else
      await run(FFMPEG(), ["-y", "-v", "error", ...SAFE_FILES, "-f", "matroska", "-i", joined, ...common, "-vf", "split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none", "-loop", "0", staged], timeoutMs);

    const bytes = statSync(staged).size;
    if (plan.output.max_bytes !== undefined && bytes > plan.output.max_bytes)
      throw new Error(`output is ${bytes} bytes, over output.max_bytes ${plan.output.max_bytes}: cut clips, or lower fps or size (nothing was written)`);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(staged, out);
    const summary = await probe(out, timeoutMs);
    return { out, bytes, duration_s: summary.duration_s, clips: plan.clips.length, probe: summary };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
