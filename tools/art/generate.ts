// Art generation over the two paid providers researched in PROVIDERS.md (T3) and the local lab
// ComfyUI ("comfy", T31). One interface, provider chosen per call. Keys come only from env and never
// appear in results, logs, or errors. Every call reports cost_micro_usd (reported when the provider
// tells us, estimated from the documented price table otherwise — never 0 for a paid call; comfy
// is local and reports 0 with cost_source "local").

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodePng, encodePng } from "./png.ts";
import { contactSheet } from "./ops.ts";

export type ProviderName = "pixellab" | "retrodiffusion" | "comfy";

export interface GenerateInput {
  provider: ProviderName;
  prompt: string;
  width: number;
  height: number;
  /** Workspace-relative output path. One image → exactly this path; several → -0, -1, … before .png. */
  out: string;
  /** Workspace-relative reference/anchor PNG (subject consistency). */
  reference?: string;
  seed?: number;
  /** Animation. Retro Diffusion: frames_duration 4|6|8|10|12|16. PixelLab: animates `reference` (required,
   *  the first frame) with `prompt` as the action, 4–16 even frames (animate-with-text-v3). */
  frames?: number;
  /** Transparent background (default true). */
  transparent?: boolean;
  /** Retro Diffusion prompt_style id (default rd_pro__default). Ignored by PixelLab. */
  style?: string;
  /** Keep at most this many returned images (default 4, max 8); the rest are discarded unwritten. */
  maxCandidates?: number;
  /** PixelLab: collect an already-submitted background job by id instead of submitting a new one
   *  (after a timeout or poll failure). Same inputs as the original call; costs no new generation. */
  resumeJobId?: string;
  /** comfy only: negative prompt text (default empty). */
  negative?: string;
}

export interface GenerateOptions {
  workspace: string;
  baseUrl?: Partial<Record<ProviderName, string>>;
  fetchImpl?: typeof fetch;
  /** Poll interval for async jobs (default 2000 ms). */
  pollIntervalMs?: number;
  /** Overall deadline (default 180_000 ms). */
  timeoutMs?: number;
  /** Env source for API keys (default process.env). Keys are read, never written or logged. */
  env?: Record<string, string | undefined>;
}

export interface GenerateResult {
  provider: ProviderName;
  /** Workspace-relative paths of the PNGs written. */
  images: string[];
  cost_micro_usd: number;
  cost_source: "reported" | "estimated" | "collected" | "local";
  /** Provider facts (job/task ids, balances, model). No auth material, no image payloads. */
  metadata: Record<string, unknown>;
}

export const RD_FRAMES = [4, 6, 8, 10, 12, 16] as const;
export const DEFAULT_CANDIDATES = 4;
export const MAX_CANDIDATES = 8;

/** Containment check for workspace-relative paths (mirrors the runner's workspace rule). */
export function resolveInside(workspace: string, rel: string): string {
  const p = path.resolve(workspace, rel || ".");
  if (p !== workspace && !p.startsWith(workspace + path.sep)) throw new Error(`path escapes the workspace: ${rel}`);
  return p;
}

const usdToMicro = (usd: number) => Math.round(usd * 1e6);

/** Documented fallback prices (PROVIDERS.md); used only when the provider reports no cost. */
export function retrodiffusionEstimateUsd(style: string, numImages = 1): number {
  if (style.startsWith("rd_mini__fast_") || style.startsWith("rd_fast")) return 0.03 * numImages;
  if (style.startsWith("rd_mini") || style.startsWith("rd_plus")) return 0.06 * numImages;
  if (style.startsWith("rd_tile__tileset")) return 0.1 * numImages;
  if (style.startsWith("rd_tile")) return 0.06 * numImages;
  if (style.startsWith("rd_advanced_animation__rotate")) return 0.1;
  if (style.startsWith("rd_advanced_animation__custom_action") || style.startsWith("rd_advanced_animation__subtle_motion")) return 0.25;
  if (style.startsWith("rd_advanced_animation")) return 0.14;
  if (style.startsWith("rd_animation__any_animation") || style.startsWith("rd_animation__big_animation") || style.startsWith("rd_animation__8_dir_rotation")) return 0.25;
  if (style.startsWith("rd_animation")) return 0.07;
  if (style.startsWith("rd_pro__fps_weapon")) return 0.25;
  return 0.18 * numImages; // rd_pro and the conservative default
}

const PIXELLAB_ESTIMATE_USD = 0.02; // generate-image-v2 (the API's own usage examples)
/** animate-with-text-v3 documents no per-call cost; a conservative placeholder until one live call measures it. */
export const PIXELLAB_ANIMATION_ESTIMATE_USD = 0.1;
/** animate-with-text-v3 limits (OpenAPI, read 2026-11-08): frame_count 4–16 and even; each side ≤ 256; w×h×frames ≤ 524,288. */
export const PL_ANIM = { minFrames: 4, maxFrames: 16, maxSide: 256, pixelBudget: 524_288 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/**
 * A failure after the provider accepted a paid job. Carries the cost the call will
 * (or did) bill: reported when the provider said so, else the table estimate marked
 * "estimated (failed after submit)" — a paid attempt is never a silent $0.
 */
export class ChargedFailure extends Error {
  cost_micro_usd: number;
  cost_source: string;
  /** The provider's background job, when one exists: collect it later instead of regenerating. */
  job_id?: string;
  constructor(message: string, costMicroUsd: number, source: string, jobId?: string) {
    const hint = jobId ? ` [job_id=${jobId}: the job may still finish; collect it with resume_job_id "${jobId}" (same inputs) instead of regenerating]` : "";
    super(`${message} [cost_micro_usd=${costMicroUsd} cost_source=${source}]${hint}`);
    this.name = "ChargedFailure";
    this.cost_micro_usd = costMicroUsd;
    this.cost_source = source;
    if (jobId) this.job_id = jobId;
  }
}

/**
 * The provider's account cannot fund the call (free-trial credits gone): Retro Diffusion 402
 * (`not_enough_balance`), PixelLab 402 "Insufficient credits/generations". Never retried and
 * never charged (nothing was accepted); the capability marks the provider exhausted.
 */
export class ProviderExhausted extends Error {
  provider: ProviderName;
  remaining_balance: number | null;
  constructor(provider: ProviderName, detail: string, remaining: number | null = null) {
    super(`${provider} is out of credits (${detail}); it is marked exhausted until a human clears it (npm run art -- providers --clear ${provider})`);
    this.name = "ProviderExhausted";
    this.provider = provider;
    this.remaining_balance = remaining;
  }
}

/**
 * The provider cannot be reached right now (comfy: the lab is down or not started). Transient: never
 * persisted as exhausted, so the next call probes again; the capability falls back to pixellab once.
 */
export class ProviderUnavailable extends Error {
  provider: ProviderName;
  constructor(provider: ProviderName, detail: string) {
    super(`${provider} is unavailable (${detail}); it is not marked exhausted, so a later call tries it again`);
    this.name = "ProviderUnavailable";
    this.provider = provider;
  }
}

/** Out-of-balance answers, per PROVIDERS.md: any 402, or RD's not_enough_balance code (v1 answered 400). */
export function exhaustedAnswer(status: number, body: any): boolean {
  return status === 402 || body?.error?.code === "not_enough_balance";
}

/** Expensive animation endpoints: frames, or an rd_animation / rd_advanced_animation style. */
export const isAnimation = (input: Pick<GenerateInput, "frames" | "style">) =>
  input.frames !== undefined || /^rd_(advanced_)?animation__/.test(input.style ?? "");

/** Reported cost if the provider stated one, else the table estimate for the in-flight call. */
function failureCost(provider: ProviderName, input: GenerateInput, reportedUsd?: number): { micro: number; source: string } {
  if (reportedUsd !== undefined) return { micro: usdToMicro(reportedUsd), source: "reported" };
  const style = input.style ?? "rd_pro__default";
  return provider === "retrodiffusion"
    ? { micro: usdToMicro(retrodiffusionEstimateUsd(style)), source: "estimated (failed after submit)" }
    : { micro: usdToMicro(input.frames !== undefined ? PIXELLAB_ANIMATION_ESTIMATE_USD : PIXELLAB_ESTIMATE_USD), source: "estimated (failed after submit)" };
}

/** Build the ChargedFailure for a post-submit throw (keeps the original message). */
function charged(provider: ProviderName, input: GenerateInput, message: string, reportedUsd?: number, jobId?: string): ChargedFailure {
  // collecting an existing job bills nothing new: its failures carry the job id at zero cost
  if (input.resumeJobId) return new ChargedFailure(message, 0, "no new charge (collect)", jobId);
  const { micro, source } = failureCost(provider, input, reportedUsd);
  return new ChargedFailure(message, micro, source, jobId);
}

function requireKey(env: Record<string, string | undefined>, name: string): string {
  const key = env[name]?.trim();
  if (!key) throw new Error(`${name} is not set: paid generation is unavailable (add the key to the environment)`);
  return key;
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

async function readReference(workspace: string, rel: string): Promise<{ base64: string; width: number; height: number }> {
  const bytes = new Uint8Array(await readFile(resolveInside(workspace, rel)));
  const img = decodePng(bytes); // validates it is a decodable PNG and gives the size PixelLab requires
  return { base64: Buffer.from(bytes).toString("base64"), width: img.width, height: img.height };
}

/** Cap the candidates a call keeps (the API may return many); the rest are dropped before writing. */
export function keepCandidates<T>(images: T[], max = DEFAULT_CANDIDATES): { kept: T[]; discarded: number } {
  const n = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(max)));
  return { kept: images.slice(0, n), discarded: Math.max(0, images.length - n) };
}

async function writeImages(workspace: string, out: string, images: Uint8Array[][]): Promise<string[]> {
  const outs: string[] = [];
  const multi = images.length > 1;
  let index = 0;
  for (const frames of images) {
    for (const bytes of frames) {
      if (!isPng(bytes)) throw new Error("provider returned a non-PNG payload (e.g. a GIF); request a spritesheet or a still style");
      const rel = multi ? out.replace(/\.png$/i, `-${index}.png`) : out;
      const abs = resolveInside(workspace, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      outs.push(rel);
      index++;
    }
  }
  if (outs.length === 0) throw new Error("provider returned no images");
  return outs;
}

/** Save frames byte-for-byte as <out dir>/<name>.frame-<i>.png (workspace-relative paths returned). */
async function writeRawFrames(workspace: string, out: string, frames: Uint8Array[]): Promise<string[]> {
  const stem = out.replace(/\.png$/i, "");
  const rels: string[] = [];
  for (const [i, bytes] of frames.entries()) {
    const rel = `${stem}.frame-${i}.png`;
    const abs = resolveInside(workspace, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    rels.push(rel);
  }
  return rels;
}

/**
 * The generation deadline when the caller sets none: ART_GENERATE_TIMEOUT_MS, else 600 s for a PixelLab
 * animation (30-180 s each, queued one at a time on Tier 1), else 180 s.
 */
export function defaultTimeoutMs(input: Pick<GenerateInput, "provider" | "frames">, env: Record<string, string | undefined> = process.env): number {
  const envTimeout = Number(env.ART_GENERATE_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) return envTimeout;
  return input.provider === "pixellab" && input.frames !== undefined ? 600_000 : 180_000;
}

export async function generate(input: GenerateInput, opts: GenerateOptions): Promise<GenerateResult> {
  if (!/\.png$/i.test(input.out)) throw new Error(`out must end in .png, got "${input.out}"`);
  resolveInside(opts.workspace, input.out); // refuse path escapes before spending money
  // Default deadline is configurable: PixelLab Tier 1 runs one job at a time and portraits took over 180 s on Nov 7;
  // a job that times out still runs (and counts) on the provider side, so a short deadline wastes generations.
  const defaultTimeout = defaultTimeoutMs(input, opts.env ?? process.env);
  if (opts.pollIntervalMs === undefined || opts.timeoutMs === undefined) {
    opts = { pollIntervalMs: 2000, timeoutMs: defaultTimeout, ...opts };
  }
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? defaultTimeout);

  const sleep = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };
  if (input.resumeJobId !== undefined && input.provider !== "pixellab") throw new Error("resume_job_id collects PixelLab background jobs only");
  if (input.resumeJobId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(input.resumeJobId)) throw new Error(`resume_job_id "${input.resumeJobId}" is not a job id`);
  if (input.provider === "retrodiffusion") return retrodiffusion(input, opts, env, fetchImpl, deadline, sleep);
  if (input.provider === "comfy") return comfy(input, opts, env, fetchImpl, deadline, sleep);
  return pixellab(input, opts, env, fetchImpl, deadline, sleep);
}

/** USD from a PixelLab-style usage object ({type:"usd", usd}); undefined when absent or non-USD. */
function usageUsd(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as { type?: unknown; usd?: unknown };
  return (u.type === undefined || u.type === "usd") && typeof u.usd === "number" ? u.usd : undefined;
}

/** Abort signal for whatever is left of the overall deadline (at least 1 ms). */
const untilDeadline = (deadline: number) => AbortSignal.timeout(Math.max(1, deadline - Date.now()));

export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** Download a hosted result with the deadline and a size cap. */
async function download(fetchImpl: typeof fetch, url: string, deadline: number): Promise<Uint8Array> {
  const res = await fetchImpl(url, { signal: untilDeadline(deadline) });
  if (!res.ok) throw new Error(`downloading generated image failed (${res.status}): ${url}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`generated image is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte cap`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`generated image is ${bytes.length} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte cap`);
  return bytes;
}

async function httpJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<{ status: number; body: any }> {
  const res = await fetchImpl(url, { ...init, signal: untilDeadline(deadline) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

/**
 * Errors where the request body never reached the provider (no connection was made), so no job
 * can exist. Anything else — a reset or abort mid-flight, a timeout, an unreadable answer — may
 * have left an accepted job behind.
 */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
export function neverSent(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } })?.cause;
  if (!cause) return false;
  if (typeof cause.code === "string") return NOT_SENT_CODES.has(cause.code);
  // happy-eyeballs: an AggregateError of per-address connect failures
  return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every((x) => typeof x?.code === "string" && NOT_SENT_CODES.has(x.code));
}

/**
 * The paid submit POST. Uncharged only for a 4xx answer (the provider refused the job) or a
 * connection that never carried the request; every other failure is a ChargedFailure at the
 * table estimate, since the provider may have accepted (and will bill) the job.
 */
async function submitJson(provider: ProviderName, input: GenerateInput, fetchImpl: typeof fetch, url: string, init: RequestInit, deadline: number): Promise<{ status: number; body: any }> {
  let submitted: { status: number; body: any };
  try {
    submitted = await httpJson(fetchImpl, url, init, deadline);
  } catch (e) {
    if (neverSent(e)) throw new Error(`${provider} submit failed before the request was sent: ${(e as Error).message}${(e as any)?.cause?.code ? ` (${(e as any).cause.code})` : ""}`);
    throw charged(provider, input, `${provider} submit failed after the request was sent: ${(e as Error).message}`);
  }
  if (submitted.status >= 500) throw charged(provider, input, `${provider} submit failed (${submitted.status}): ${JSON.stringify(submitted.body).slice(0, 300)}`);
  return submitted;
}

/** The Retro Diffusion inference body (shared by generation and the free check_cost quote). */
async function rdBody(input: GenerateInput, workspace: string, style: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    prompt_style: style,
    width: input.width,
    height: input.height,
    num_images: 1,
    remove_bg: input.transparent ?? true,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  if (input.frames !== undefined) {
    body.frames_duration = input.frames;
    body.return_spritesheet = true;
  }
  if (input.reference) body.reference_images = [(await readReference(workspace, input.reference)).base64];
  return body;
}

async function retrodiffusion(
  input: GenerateInput,
  opts: GenerateOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenerateResult> {
  const key = requireKey(env, "RETRO_DIFFUSION_API_KEY");
  const base = (opts.baseUrl?.retrodiffusion ?? env.RETRO_DIFFUSION_BASE_URL ?? "https://api.retrodiffusion.ai").replace(/\/$/, "");
  const style = input.style ?? "rd_pro__default";
  if (input.frames !== undefined && !(RD_FRAMES as readonly number[]).includes(input.frames))
    throw new Error(`frames must be one of frames_duration ${RD_FRAMES.join("|")}, got ${input.frames}`);

  const body = await rdBody(input, opts.workspace, style);

  const submitted = await submitJson("retrodiffusion", input, fetchImpl, `${base}/v2/inferences`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-RD-Token": key, "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  }, deadline);
  if (exhaustedAnswer(submitted.status, submitted.body))
    throw new ProviderExhausted("retrodiffusion", `${submitted.status} ${submitted.body?.error?.code ?? ""} ${submitted.body?.error?.message ?? ""}`.trim(), typeof submitted.body?.remaining_balance === "number" ? submitted.body.remaining_balance : null);
  if (submitted.status >= 400)
    throw new Error(`retrodiffusion rejected the request (${submitted.status}): ${submitted.body?.error?.message ?? submitted.body?.detail ?? JSON.stringify(submitted.body).slice(0, 300)}`);
  const taskId = submitted.body?.task_id;
  if (!taskId) throw charged("retrodiffusion", input, `retrodiffusion returned no task_id: ${JSON.stringify(submitted.body).slice(0, 300)}`);
  const submittedUsd = usageUsd(submitted.body?.usage) ?? (typeof submitted.body?.balance_cost === "number" ? submitted.body.balance_cost : undefined);

  let result: any = null;
  for (;;) {
    if (Date.now() > deadline) throw charged("retrodiffusion", input, `retrodiffusion generation timed out after ${opts.timeoutMs} ms (task ${taskId})`, submittedUsd);
    const poll = await httpJson(fetchImpl, `${base}/v2/inferences/tasks/${taskId}`, { headers: { "X-RD-Token": key } }, deadline).catch((e: unknown) => {
      throw charged("retrodiffusion", input, `retrodiffusion task poll failed: ${(e as Error).message}`, submittedUsd);
    });
    if (poll.status >= 400)
      throw charged("retrodiffusion", input, `retrodiffusion task poll failed (${poll.status}): ${poll.body?.error?.message ?? JSON.stringify(poll.body).slice(0, 300)}`, submittedUsd);
    if (poll.body?.status === "failed")
      throw charged("retrodiffusion", input, `retrodiffusion task failed: ${poll.body?.error?.detail ?? poll.body?.error?.message ?? JSON.stringify(poll.body.error).slice(0, 300)}`, submittedUsd);
    if (poll.body?.status === "succeeded") {
      result = poll.body.result;
      break;
    }
    await sleep(opts.pollIntervalMs ?? 2000);
  }

  const reportedUsd = typeof result?.balance_cost === "number" ? result.balance_cost : submittedUsd;
  let written: string[];
  let discarded = 0;
  try {
    // cap before decoding or downloading: discarded candidates are never fetched or written
    const b64s = (result?.base64_images ?? []) as string[];
    const cap = b64s.length ? keepCandidates(b64s, input.maxCandidates) : keepCandidates((result?.output_urls ?? []) as string[], input.maxCandidates);
    discarded = cap.discarded;
    const images: Uint8Array[][] = [];
    for (const item of cap.kept) images.push([b64s.length ? new Uint8Array(Buffer.from(item, "base64")) : await download(fetchImpl, item, deadline)]);
    written = await writeImages(opts.workspace, input.out, images);
  } catch (e) {
    throw charged("retrodiffusion", input, (e as Error).message, reportedUsd);
  }
  const costUsd = reportedUsd ?? retrodiffusionEstimateUsd(style);
  return {
    provider: "retrodiffusion",
    images: written,
    cost_micro_usd: usdToMicro(costUsd),
    cost_source: reportedUsd === undefined ? "estimated" : "reported",
    metadata: {
      task_id: taskId,
      request_id: result?.request_id,
      model: result?.model,
      remaining_balance: result?.remaining_balance,
      style,
      images_returned: ((result?.base64_images ?? []) as string[]).length + ((result?.output_urls ?? []) as string[]).length,
      candidates_discarded: discarded,
    },
  };
}

/** Collect base64 image objects ({base64, …}) from a completed PixelLab job response, in document order. */
function collectBase64Images(node: unknown, out: string[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectBase64Images(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.base64 === "string" && (record.type === undefined || record.type === "base64")) {
    out.push(record.base64);
    return;
  }
  for (const value of Object.values(record)) collectBase64Images(value, out);
}

/** Poll a PixelLab background job to completion (same deadline and charged errors for stills and animations). */
async function pollPixellabJob(
  base: string, key: string, jobId: string, input: GenerateInput, opts: GenerateOptions,
  fetchImpl: typeof fetch, deadline: number, sleep: (ms: number) => Promise<void>, submittedUsd: number | undefined,
): Promise<any> {
  for (;;) {
    if (Date.now() > deadline) throw charged("pixellab", input, `pixellab generation timed out after ${opts.timeoutMs} ms (job ${jobId})`, submittedUsd, jobId);
    const poll = await httpJson(fetchImpl, `${base}/v2/background-jobs/${jobId}`, { headers: { authorization: `Bearer ${key}` } }, deadline).catch((e: unknown) => {
      throw charged("pixellab", input, `pixellab job poll failed: ${(e as Error).message}`, submittedUsd, jobId);
    });
    if (poll.status >= 400)
      throw charged("pixellab", input, `pixellab job poll failed (${poll.status}): ${poll.body?.detail ?? JSON.stringify(poll.body).slice(0, 300)}`, submittedUsd, jobId);
    if (poll.body?.status === "failed")
      throw charged("pixellab", input, `pixellab job failed: ${JSON.stringify(poll.body?.last_response?.detail ?? poll.body?.last_response ?? poll.body).slice(0, 300)}`, usageUsd(poll.body?.usage) ?? submittedUsd);
    if (poll.body?.status === "completed") return poll.body;
    await sleep(opts.pollIntervalMs ?? 2000);
  }
}

/** Raw base64 from a `data:image/png;base64,…` URI or a bare string. */
const stripDataUri = (b64: string) => b64.replace(/^data:[^;,]+;base64,/, "");

/** Validate a PixelLab animation request against the documented limits, before any request or spend. */
export function validatePixellabAnimation(frames: number, ref: { width: number; height: number } | null): void {
  if (!Number.isInteger(frames) || frames < PL_ANIM.minFrames || frames > PL_ANIM.maxFrames || frames % 2 !== 0)
    throw new Error(`pixellab frames must be an even number from ${PL_ANIM.minFrames} to ${PL_ANIM.maxFrames} (4, 6, 8, 10, 12, 14, 16), got ${frames}`);
  if (!ref) throw new Error("pixellab animation needs `reference`: the still to animate (it is the first frame; `prompt` is the action, e.g. 'walking')");
  if (ref.width > PL_ANIM.maxSide || ref.height > PL_ANIM.maxSide)
    throw new Error(`pixellab animation reference is ${ref.width}x${ref.height}; each side must be at most ${PL_ANIM.maxSide} px`);
  if (ref.width * ref.height * frames > PL_ANIM.pixelBudget) {
    const fit = Math.floor(PL_ANIM.pixelBudget / (ref.width * ref.height) / 2) * 2;
    throw new Error(`pixellab animation budget: ${ref.width}x${ref.height} × ${frames} frames = ${ref.width * ref.height * frames} px, over ${PL_ANIM.pixelBudget}; at this size use at most ${fit} frames`);
  }
}

/**
 * Animate a reference still from a text action: `POST /v2/animate-with-text-v3` (first_frame + action +
 * frame_count) → background job → `last_response.images`, written as ONE horizontal strip per
 * animation (N frames of the reference's size, 1 row), the layout art_gate checks.
 */
async function pixellabAnimate(
  input: GenerateInput,
  opts: GenerateOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenerateResult> {
  const frames = input.frames!;
  validatePixellabAnimation(frames, input.reference ? { width: 1, height: 1 } : null); // frame count and reference first
  const ref = await readReference(opts.workspace, input.reference!);
  validatePixellabAnimation(frames, ref);
  if (input.width !== ref.width || input.height !== ref.height)
    throw new Error(`pixellab animation frames are the reference's size: pass width ${ref.width} and height ${ref.height} (got ${input.width}x${input.height})`);
  const key = requireKey(env, "PIXELLAB_API_KEY");
  const base = (opts.baseUrl?.pixellab ?? env.PIXELLAB_BASE_URL ?? "https://api.pixellab.ai").replace(/\/$/, "");

  const body: Record<string, unknown> = {
    first_frame: { type: "base64", base64: ref.base64, format: "png" },
    action: input.prompt.slice(0, 1000),
    frame_count: frames,
    no_background: input.transparent ?? true,
  };
  if (input.seed !== undefined) body.seed = input.seed;

  const submitted = input.resumeJobId
    ? { status: 200, body: { background_job_id: input.resumeJobId } as any }
    : await submitJson("pixellab", input, fetchImpl, `${base}/v2/animate-with-text-v3`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }, deadline);
  if (exhaustedAnswer(submitted.status, submitted.body))
    throw new ProviderExhausted("pixellab", `${submitted.status} ${submitted.body?.detail ?? "Insufficient credits"}`);
  if (submitted.status >= 400)
    throw new Error(`pixellab rejected the animation (${submitted.status}): ${JSON.stringify(submitted.body?.detail ?? submitted.body).slice(0, 300)}`);
  const jobId: string = submitted.body?.background_job_id;
  if (!jobId) throw charged("pixellab", input, `pixellab returned no background_job_id: ${JSON.stringify(submitted.body).slice(0, 300)}`);
  const submittedUsd = usageUsd(submitted.body?.usage);
  const job = await pollPixellabJob(base, key, jobId, input, opts, fetchImpl, deadline, sleep, submittedUsd);

  const usage = (job?.usage ?? submitted.body?.usage) as { type?: string; usd?: number; generations?: number } | null | undefined;
  const reportedUsd = usageUsd(usage);
  const notes: string[] = [];
  let written: string[];
  let discarded = 0;
  let returned = 0;
  let perStrip = frames;
  try {
    // frames in document order: base64 image objects, raw/data-URI strings, or hosted URLs
    const items: unknown[] = Array.isArray(job?.last_response?.images) ? job.last_response.images : [];
    const pngs: Uint8Array[] = [];
    for (const it of items) {
      const o = it as { base64?: unknown; url?: unknown } | string;
      const url = typeof o === "string" ? (/^https?:\/\//.test(o) ? o : null) : typeof o?.url === "string" ? o.url : null;
      if (url) pngs.push(await download(fetchImpl, url, deadline));
      else {
        const b64 = typeof o === "string" ? o : typeof o?.base64 === "string" ? o.base64 : null;
        if (b64) pngs.push(new Uint8Array(Buffer.from(stripDataUri(b64), "base64")));
      }
    }
    if (pngs.length === 0) {
      const any: string[] = [];
      collectBase64Images(job?.last_response, any);
      for (const b64 of any) pngs.push(new Uint8Array(Buffer.from(stripDataUri(b64), "base64")));
    }
    returned = pngs.length;
    if (returned === 0) throw new Error("pixellab animation completed but carried no frames");
    // Group into animations. Docs: frames at last_response.images; whether the input frame is echoed
    // and whether several candidates can come back is undocumented, so handle the shapes we can name.
    let groups: Uint8Array[][];
    if (returned === frames) groups = [pngs];
    else if (returned === frames + 1) {
      groups = [pngs.slice(1)];
      notes.push(`received ${returned} frames for frame_count ${frames}; dropped index 0 (the echoed input frame)`);
    } else if (returned % frames === 0) groups = Array.from({ length: returned / frames }, (_, k) => pngs.slice(k * frames, (k + 1) * frames));
    else {
      groups = [pngs];
      perStrip = returned;
      notes.push(`received ${returned} frames for frame_count ${frames}; wrote them all as one strip of ${returned} — check the manifest frames before gating`);
    }
    const cap = keepCandidates(groups, input.maxCandidates);
    discarded = cap.discarded;
    const strips: Uint8Array[][] = [];
    try {
      for (const g of cap.kept) {
        const imgs = g.map((b) => {
          if (!isPng(b)) throw new Error("pixellab returned a non-PNG frame");
          return decodePng(b);
        });
        if (imgs[0].width !== ref.width || imgs[0].height !== ref.height)
          notes.push(`frames are ${imgs[0].width}x${imgs[0].height}, not the reference's ${ref.width}x${ref.height}`);
        strips.push([encodePng(contactSheet(imgs).image)]); // horizontal, no gap, frame order kept
      }
    } catch (e) {
      // a billed job is never thrown away: keep every returned frame as-is next to the intended strip
      const saved = await writeRawFrames(opts.workspace, input.out, pngs);
      throw new Error(`could not build the strip (${(e as Error).message}); the ${pngs.length} raw frames were saved as ${saved.join(", ")}`);
    }
    written = await writeImages(opts.workspace, input.out, strips);
  } catch (e) {
    throw charged("pixellab", input, (e as Error).message, reportedUsd, jobId);
  }
  const costUsd = reportedUsd ?? PIXELLAB_ANIMATION_ESTIMATE_USD;
  return {
    provider: "pixellab",
    images: written,
    cost_micro_usd: input.resumeJobId ? 0 : usdToMicro(costUsd),
    cost_source: input.resumeJobId ? "collected" : reportedUsd === undefined ? "estimated" : "reported",
    metadata: {
      endpoint: "animate-with-text-v3", background_job_id: jobId, ...(input.resumeJobId ? { collected: true } : {}), usage: usage ?? null, created_at: job?.created_at,
      frames_per_strip: perStrip, frame_size: { w: ref.width, h: ref.height }, frames_returned: returned, candidates_discarded: discarded,
      ...(notes.length ? { notes } : {}),
    },
  };
}

async function pixellab(
  input: GenerateInput,
  opts: GenerateOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenerateResult> {
  if (input.frames !== undefined) return pixellabAnimate(input, opts, env, fetchImpl, deadline, sleep);
  const key = requireKey(env, "PIXELLAB_API_KEY");
  const base = (opts.baseUrl?.pixellab ?? env.PIXELLAB_BASE_URL ?? "https://api.pixellab.ai").replace(/\/$/, "");

  const body: Record<string, unknown> = {
    description: input.prompt,
    image_size: { width: input.width, height: input.height },
    no_background: input.transparent ?? true,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  if (input.reference) {
    const ref = await readReference(opts.workspace, input.reference);
    body.reference_images = [{ image: { type: "base64", base64: ref.base64, format: "png" }, size: { width: ref.width, height: ref.height } }];
  }

  const submitted = input.resumeJobId
    ? { status: 200, body: { background_job_id: input.resumeJobId } as any }
    : await submitJson("pixellab", input, fetchImpl, `${base}/v2/generate-image-v2`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }, deadline);
  if (exhaustedAnswer(submitted.status, submitted.body))
    throw new ProviderExhausted("pixellab", `${submitted.status} ${submitted.body?.detail ?? "Insufficient credits"}`);
  if (submitted.status >= 400)
    throw new Error(`pixellab rejected the request (${submitted.status}): ${submitted.body?.detail ?? JSON.stringify(submitted.body).slice(0, 300)}`);
  const jobId = submitted.body?.background_job_id;
  if (!jobId) throw charged("pixellab", input, `pixellab returned no background_job_id: ${JSON.stringify(submitted.body).slice(0, 300)}`);
  const submittedUsd = usageUsd(submitted.body?.usage);

  const job = await pollPixellabJob(base, key, jobId, input, opts, fetchImpl, deadline, sleep, submittedUsd);

  const usage = (job?.usage ?? submitted.body?.usage) as { type?: string; usd?: number } | null | undefined;
  const reportedUsd = usageUsd(usage);
  let written: string[];
  let discarded = 0;
  try {
    const b64s: string[] = [];
    collectBase64Images(job?.last_response, b64s);
    if (b64s.length === 0) throw new Error("pixellab job completed but carried no image payload");
    const cap = keepCandidates(b64s, input.maxCandidates);
    discarded = cap.discarded;
    written = await writeImages(opts.workspace, input.out, cap.kept.map((b64) => [new Uint8Array(Buffer.from(b64, "base64"))]));
  } catch (e) {
    throw charged("pixellab", input, (e as Error).message, reportedUsd, jobId);
  }
  const costUsd = reportedUsd ?? PIXELLAB_ESTIMATE_USD;
  return {
    provider: "pixellab",
    images: written,
    cost_micro_usd: input.resumeJobId ? 0 : usdToMicro(costUsd),
    cost_source: input.resumeJobId ? "collected" : reportedUsd === undefined ? "estimated" : "reported",
    metadata: { background_job_id: jobId, ...(input.resumeJobId ? { collected: true } : {}), usage: usage ?? null, created_at: job?.created_at, candidates_discarded: discarded },
  };
}

// ---------- comfy: the isolated lab ComfyUI (T31). Local, free, stills only. ----------

/**
 * The lab's frozen recipe (fabric-character-lab HANDOFF.md + generate_agent_set.py, read 2026-11-08):
 * NovaPixelILV3 + NoobAI IP-Adapter at 0.65 with CLIP ViT-H on the reference, 768², 30 steps, CFG 7,
 * euler_ancestral/normal, seed 42 unless the caller fixes one per character. No pose ControlNet.
 */
export const COMFY_RECIPE = {
  checkpoint: "NovaPixelILV3.safetensors",
  ipadapter: "ip_adapter_Noobtest_800000.bin",
  ipa_weight: 0.65,
  clip_vision: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
  size: 768,
  steps: 30,
  cfg: 7,
  sampler: "euler_ancestral",
  scheduler: "normal",
  seed: 42,
} as const;
export const COMFY_DEFAULT_BASE_URL = "http://100.96.19.87:8190";
/** The production ComfyUI port on the same host: never used by the studio. */
export const COMFY_PRODUCTION_PORT = "8188";
const COMFY_PROBE_MS = 5000;
const COMFY_SAVE_NODE = "7";

/** COMFY_BASE_URL (or the lab default), refusing the production port and non-http(s) URLs. */
export function comfyBaseUrl(opts: Pick<GenerateOptions, "baseUrl">, env: Record<string, string | undefined>): string {
  const raw = (opts.baseUrl?.comfy?.trim() || env.COMFY_BASE_URL?.trim() || COMFY_DEFAULT_BASE_URL).replace(/\/+$/, ""); // empty = unset (.env.example)
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`COMFY_BASE_URL "${raw}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`COMFY_BASE_URL "${raw}" must be http(s)`);
  if (url.port === COMFY_PRODUCTION_PORT)
    throw new Error(`refused: ${raw} is port ${COMFY_PRODUCTION_PORT}, the production ComfyUI. The studio uses only the isolated lab (default ${COMFY_DEFAULT_BASE_URL})`);
  return raw;
}

/** The recipe as a ComfyUI API graph; with `reference` (an uploaded image name) the model goes through IP-Adapter. */
/**
 * Images per comfy call (T41): max_candidates becomes the latent batch, capped by COMFY_MAX_BATCH (default 2). Lab benchmark
 * (RTX 4060 8 GB, 768², 30 steps): 1 image 43.4 s; a batch of 2 53.8 s (27 s/img) with ~4 GB VRAM still free; concurrent
 * prompts serialize. Batch 4 at 768² is not verified on 8 GB, so the default stays 2; set COMFY_MAX_BATCH (≤ 8) to go higher.
 */
export const COMFY_DEFAULT_MAX_BATCH = 2;
export function comfyMaxBatch(env: Record<string, string | undefined> = process.env): number {
  const raw = env.COMFY_MAX_BATCH?.trim();
  if (!raw) return COMFY_DEFAULT_MAX_BATCH;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CANDIDATES) throw new Error(`COMFY_MAX_BATCH must be an integer from 1 to ${MAX_CANDIDATES}, got "${raw}"`);
  return n;
}
/** The batch for one call: max_candidates (default DEFAULT_CANDIDATES), at most the cap. */
export const comfyBatch = (maxCandidates: number | undefined, cap: number) => Math.max(1, Math.min(cap, Math.floor(maxCandidates ?? DEFAULT_CANDIDATES)));

export function comfyGraph(o: { prompt: string; negative: string; seed: number; reference?: string; prefix: string; batch?: number }): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const r = COMFY_RECIPE;
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: r.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: o.prompt } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: o.negative } },
    // batch: one seed, N latents. The sampler's noise differs per batch index, so the N candidates vary while the
    // seed still pins identity across calls (the same seed + batch reproduces the same N images).
    "4": { class_type: "EmptyLatentImage", inputs: { width: r.size, height: r.size, batch_size: o.batch ?? 1 } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: o.seed, steps: r.steps, cfg: r.cfg, sampler_name: r.sampler, scheduler: r.scheduler, denoise: 1 },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    [COMFY_SAVE_NODE]: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: o.prefix } },
  };
  if (o.reference !== undefined) {
    graph["8"] = { class_type: "LoadImage", inputs: { image: o.reference } };
    graph["9"] = { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: r.ipadapter } };
    graph["10"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: r.clip_vision } };
    graph["11"] = {
      class_type: "IPAdapterAdvanced",
      inputs: { model: ["1", 0], ipadapter: ["9", 0], image: ["8", 0], clip_vision: ["10", 0], weight: r.ipa_weight, weight_type: "linear", combine_embeds: "concat", start_at: 0, end_at: 1, embeds_scaling: "V only" },
    };
    graph["5"].inputs.model = ["11", 0];
  }
  return graph;
}

/**
 * One lab request. A connection that never reached the lab is ProviderUnavailable (the lab went
 * down: fall back); anything else is a plain error. Nothing is ever billed.
 */
async function comfyCall(fetchImpl: typeof fetch, base: string, route: string, init: RequestInit, deadline: number): Promise<{ status: number; body: any }> {
  try {
    return await httpJson(fetchImpl, `${base}${route}`, init, deadline);
  } catch (e) {
    if (neverSent(e)) throw new ProviderUnavailable("comfy", `${base}${route}: ${(e as Error).message}${(e as any)?.cause?.code ? ` (${(e as any).cause.code})` : ""}`);
    if (Date.now() >= deadline) throw new Error(`comfy ${route} hit the deadline`);
    throw new Error(`comfy ${route} failed: ${(e as Error).message}`);
  }
}

/**
 * Stills from the lab: health probe (GET /system_stats) → reference upload (POST /upload/image) →
 * POST /prompt with the frozen graph → poll GET /history/<id> → GET /view per output image. The
 * provider never starts or stops servers. Always 768x768 and opaque: postprocess snap/lock/outline
 * brings it to the manifest grid and palette.
 */
async function comfy(
  input: GenerateInput,
  opts: GenerateOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenerateResult> {
  if (input.frames !== undefined) throw new Error("comfy makes stills only (frozen recipe); animate the still with pixellab (frames + reference)");
  const base = comfyBaseUrl(opts, env);
  const maxBatch = comfyMaxBatch(env); // a malformed cap fails before any request
  const ref = input.reference ? await readReference(opts.workspace, input.reference) : null; // path safety before any request

  // Health probe, short: an unreachable or unready lab moves the call elsewhere instead of hanging.
  try {
    const probe = await fetchImpl(`${base}/system_stats`, { signal: AbortSignal.timeout(Math.max(1, Math.min(COMFY_PROBE_MS, deadline - Date.now()))) });
    await probe.arrayBuffer().catch(() => undefined);
    if (!probe.ok) throw new ProviderUnavailable("comfy", `${base}/system_stats answered ${probe.status}`);
  } catch (e) {
    if (e instanceof ProviderUnavailable) throw e;
    throw new ProviderUnavailable("comfy", `${base}/system_stats: ${(e as Error).message}${(e as any)?.cause?.code ? ` (${(e as any).cause.code})` : ""}`);
  }

  let uploaded: string | undefined;
  if (ref) {
    const bytes = Buffer.from(ref.base64, "base64");
    const name = `anyco-ref-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.png`;
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), name);
    form.append("overwrite", "true");
    const up = await comfyCall(fetchImpl, base, "/upload/image", { method: "POST", body: form }, deadline);
    if (up.status >= 400 || typeof up.body?.name !== "string")
      throw new Error(`comfy reference upload failed (${up.status}): ${JSON.stringify(up.body).slice(0, 300)}`);
    uploaded = [up.body.subfolder, up.body.name].filter((x: unknown) => typeof x === "string" && x).join("/");
  }

  const seed = input.seed ?? COMFY_RECIPE.seed;
  const batch = comfyBatch(input.maxCandidates, maxBatch);
  const graph = comfyGraph({ prompt: input.prompt, negative: input.negative ?? "", seed, reference: uploaded, prefix: `anyco/${randomUUID()}`, batch });
  const sub = await comfyCall(fetchImpl, base, "/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: "anyco-art" }) }, deadline);
  const nodeErrors = sub.body?.node_errors && Object.keys(sub.body.node_errors).length > 0 ? sub.body.node_errors : null;
  if (sub.status >= 400 || nodeErrors || sub.body?.error)
    throw new Error(`comfy rejected the graph (${sub.status}): ${JSON.stringify(sub.body?.error ?? nodeErrors ?? sub.body).slice(0, 400)}`);
  const promptId = sub.body?.prompt_id;
  if (typeof promptId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(promptId)) throw new Error(`comfy returned no prompt_id: ${JSON.stringify(sub.body).slice(0, 300)}`);

  const timedOut = () => new Error(`comfy generation timed out after ${opts.timeoutMs} ms (prompt ${promptId}; it may still finish in the lab's queue, nothing is billed)`);
  let images: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }> = [];
  for (;;) {
    if (Date.now() > deadline) throw timedOut();
    let h: { status: number; body: any };
    try {
      h = await comfyCall(fetchImpl, base, `/history/${promptId}`, {}, deadline);
    } catch (e) {
      if (Date.now() >= deadline) throw timedOut();
      throw e;
    }
    if (h.status >= 400) throw new Error(`comfy history poll failed (${h.status}): ${JSON.stringify(h.body).slice(0, 300)}`);
    const entry = h.body?.[promptId];
    if (entry) {
      if (entry.status?.status_str === "error") throw new Error(`comfy job failed: ${JSON.stringify(entry.status?.messages ?? entry.status).slice(0, 400)}`);
      const out = entry.outputs?.[COMFY_SAVE_NODE]?.images;
      if (Array.isArray(out) && out.length > 0) {
        images = out;
        break;
      }
      if (entry.status?.completed) throw new Error(`comfy job completed without an image: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    await sleep(opts.pollIntervalMs ?? 2000);
  }

  const cap = keepCandidates(images, input.maxCandidates);
  const pngs: Uint8Array[][] = [];
  for (const im of cap.kept) {
    if (typeof im.filename !== "string") throw new Error(`comfy output has no filename: ${JSON.stringify(im).slice(0, 200)}`);
    const q = new URLSearchParams({ filename: im.filename, subfolder: typeof im.subfolder === "string" ? im.subfolder : "", type: typeof im.type === "string" ? im.type : "output" });
    try {
      pngs.push([await download(fetchImpl, `${base}/view?${q}`, deadline)]);
    } catch (e) {
      if (Date.now() >= deadline) throw timedOut();
      throw e;
    }
  }
  const written = await writeImages(opts.workspace, input.out, pngs);
  const first = decodePng(pngs[0][0]);
  return {
    provider: "comfy",
    images: written,
    cost_micro_usd: 0,
    cost_source: "local",
    metadata: {
      prompt_id: promptId, base_url: base, method: uploaded ? "ipa" : "text", seed, reference_uploaded: uploaded ?? null,
      recipe: COMFY_RECIPE, batch, max_batch: maxBatch, size: { w: first.width, h: first.height }, requested_size: { w: input.width, h: input.height },
      candidates_discarded: cap.discarded,
      notes: ["comfy renders an opaque 768x768 image (the recipe has no background removal); use postprocess snap/lock/outline to reach the manifest size and palette"],
    },
  };
}

// ---------- free reads: cost quotes and balances (T19). Never a billing or purchase endpoint. ----------

export interface Quote {
  provider: ProviderName;
  per_call_usd: number;
  source: "check_cost" | "price table" | "local";
  remaining_balance: number | null;
  unit: "usd" | "generations";
  total?: number | null;
  note?: string;
}

/**
 * What one call would cost. Retro Diffusion: the documented free dry run (`check_cost: true`,
 * no Idempotency-Key, generates and charges nothing) → `balance_cost` + `remaining_balance`.
 * PixelLab has no dry run: the price table, plus the balance read if it answers.
 */
export async function quote(input: GenerateInput, opts: GenerateOptions): Promise<Quote> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  if (input.provider === "comfy")
    return { provider: "comfy", per_call_usd: 0, source: "local", remaining_balance: null, unit: "usd", total: null, note: "the local lab is free and has no balance; it can be down (art_generate then falls back to pixellab)" };
  if (input.provider === "pixellab") {
    const b = await balance("pixellab", opts).catch(() => null);
    const anim = input.frames !== undefined;
    return {
      provider: "pixellab", per_call_usd: anim ? PIXELLAB_ANIMATION_ESTIMATE_USD : PIXELLAB_ESTIMATE_USD, source: "price table",
      remaining_balance: b?.remaining ?? null, unit: b?.unit ?? "usd", total: b?.total ?? null,
      ...(anim ? { note: "PixelLab documents no generations cost for animate-with-text-v3 (and no dry run); the estimate is a placeholder. art_generate reports generations_used per call." } : {}),
    };
  }
  const key = requireKey(env, "RETRO_DIFFUSION_API_KEY");
  const base = (opts.baseUrl?.retrodiffusion ?? env.RETRO_DIFFUSION_BASE_URL ?? "https://api.retrodiffusion.ai").replace(/\/$/, "");
  const style = input.style ?? "rd_pro__default";
  const body = { ...(await rdBody(input, opts.workspace, style)), check_cost: true };
  const r = await httpJson(fetchImpl, `${base}/v2/inferences`, { method: "POST", headers: { "content-type": "application/json", "X-RD-Token": key }, body: JSON.stringify(body) }, deadline);
  if (exhaustedAnswer(r.status, r.body)) throw new ProviderExhausted("retrodiffusion", `${r.status} on check_cost`, typeof r.body?.remaining_balance === "number" ? r.body.remaining_balance : null);
  if (r.status >= 400 || typeof r.body?.balance_cost !== "number")
    throw new Error(`retrodiffusion check_cost failed (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  return { provider: "retrodiffusion", per_call_usd: r.body.balance_cost, source: "check_cost", remaining_balance: typeof r.body.remaining_balance === "number" ? r.body.remaining_balance : null, unit: "usd" };
}

export interface Balance {
  remaining: number;
  /** PixelLab subscriptions count generations; prepaid credits are USD. */
  unit: "usd" | "generations";
  total: number | null;
}

/**
 * PixelLab `GET /v2/balance` (verified live 2026-11-07):
 * `{"credits":{"type":"usd","usd":0.0},"subscription":{"type":"generations","status":"active","plan":"…","generations":2000.0,"total":2000.0}}`.
 * An active generations subscription is the balance (remaining of total); otherwise credits.usd.
 */
export function pixellabBalance(body: any): Balance | null {
  const sub = body?.subscription;
  if (sub?.status === "active" && sub?.type === "generations" && typeof sub.generations === "number")
    return { remaining: sub.generations, unit: "generations", total: typeof sub.total === "number" ? sub.total : null };
  const usd = body?.credits?.usd ?? (typeof body?.credits === "number" ? body.credits : undefined);
  return typeof usd === "number" ? { remaining: usd, unit: "usd", total: null } : null;
}

/**
 * Remaining balance from the provider's read-only endpoint, or null when it doesn't say.
 * RD `GET /v2/inferences/credits` → `{credits, balance}` (USD balance). PixelLab: see pixellabBalance.
 */
export async function balance(provider: ProviderName, opts: Omit<GenerateOptions, "workspace">): Promise<Balance | null> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  if (provider === "comfy") return null; // local lab: no balance
  if (provider === "retrodiffusion") {
    const key = requireKey(env, "RETRO_DIFFUSION_API_KEY");
    const base = (opts.baseUrl?.retrodiffusion ?? env.RETRO_DIFFUSION_BASE_URL ?? "https://api.retrodiffusion.ai").replace(/\/$/, "");
    const r = await httpJson(fetchImpl, `${base}/v2/inferences/credits`, { headers: { "X-RD-Token": key } }, deadline);
    return r.status < 400 && typeof r.body?.balance === "number" ? { remaining: r.body.balance, unit: "usd", total: null } : null;
  }
  const key = requireKey(env, "PIXELLAB_API_KEY");
  const base = (opts.baseUrl?.pixellab ?? env.PIXELLAB_BASE_URL ?? "https://api.pixellab.ai").replace(/\/$/, "");
  const r = await httpJson(fetchImpl, `${base}/v2/balance`, { headers: { authorization: `Bearer ${key}` } }, deadline);
  return r.status < 400 ? pixellabBalance(r.body) : null;
}
