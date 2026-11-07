// Paid art generation over the two providers researched in PROVIDERS.md (T3).
// One interface, provider chosen per call. Keys come only from env and never appear in
// results, logs, or errors. Every call reports cost_micro_usd (reported when the provider
// tells us, estimated from the documented price table otherwise — never 0 for a paid call).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodePng } from "./png.ts";

export type ProviderName = "pixellab" | "retrodiffusion";

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
  /** Animation: Retro Diffusion frames_duration (4|6|8|10|12|16); unsupported on PixelLab here. */
  frames?: number;
  /** Transparent background (default true). */
  transparent?: boolean;
  /** Retro Diffusion prompt_style id (default rd_pro__default). Ignored by PixelLab. */
  style?: string;
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
  cost_source: "reported" | "estimated";
  /** Provider facts (job/task ids, balances, model). No auth material, no image payloads. */
  metadata: Record<string, unknown>;
}

export const RD_FRAMES = [4, 6, 8, 10, 12, 16] as const;

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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

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

export async function generate(input: GenerateInput, opts: GenerateOptions): Promise<GenerateResult> {
  resolveInside(opts.workspace, input.out); // refuse path escapes before spending money
  if (opts.pollIntervalMs === undefined || opts.timeoutMs === undefined) {
    opts = { pollIntervalMs: 2000, timeoutMs: 180_000, ...opts };
  }
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);

  const sleep = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };
  if (input.provider === "retrodiffusion") return retrodiffusion(input, opts, env, fetchImpl, deadline, sleep);
  return pixellab(input, opts, env, fetchImpl, deadline, sleep);
}

async function httpJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
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
  if (input.reference) body.reference_images = [(await readReference(opts.workspace, input.reference)).base64];

  const submitted = await httpJson(fetchImpl, `${base}/v2/inferences`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-RD-Token": key, "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });
  if (submitted.status >= 400)
    throw new Error(`retrodiffusion rejected the request (${submitted.status}): ${submitted.body?.error?.message ?? submitted.body?.detail ?? JSON.stringify(submitted.body).slice(0, 300)}`);
  const taskId = submitted.body?.task_id;
  if (!taskId) throw new Error(`retrodiffusion returned no task_id: ${JSON.stringify(submitted.body).slice(0, 300)}`);

  let result: any = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`retrodiffusion generation timed out after ${opts.timeoutMs} ms (task ${taskId})`);
    const poll = await httpJson(fetchImpl, `${base}/v2/inferences/tasks/${taskId}`, { headers: { "X-RD-Token": key } });
    if (poll.status >= 400)
      throw new Error(`retrodiffusion task poll failed (${poll.status}): ${poll.body?.error?.message ?? JSON.stringify(poll.body).slice(0, 300)}`);
    if (poll.body?.status === "failed")
      throw new Error(`retrodiffusion task failed: ${poll.body?.error?.detail ?? poll.body?.error?.message ?? JSON.stringify(poll.body.error).slice(0, 300)}`);
    if (poll.body?.status === "succeeded") {
      result = poll.body.result;
      break;
    }
    await sleep(opts.pollIntervalMs ?? 2000);
  }

  const images: Uint8Array[][] = [];
  for (const b64 of (result?.base64_images ?? []) as string[]) images.push([new Uint8Array(Buffer.from(b64, "base64"))]);
  if (images.length === 0)
    for (const url of (result?.output_urls ?? []) as string[]) {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`downloading generated image failed (${res.status}): ${url}`);
      images.push([new Uint8Array(await res.arrayBuffer())]);
    }

  const written = await writeImages(opts.workspace, input.out, images);
  const reportedUsd = typeof result?.balance_cost === "number" ? result.balance_cost : undefined;
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

async function pixellab(
  input: GenerateInput,
  opts: GenerateOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenerateResult> {
  if (input.frames !== undefined) throw new Error("frames are not supported for pixellab through this interface (animation endpoints are a later ticket; see PROVIDERS.md)");
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

  const submitted = await httpJson(fetchImpl, `${base}/v2/generate-image-v2`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (submitted.status >= 400)
    throw new Error(`pixellab rejected the request (${submitted.status}): ${submitted.body?.detail ?? JSON.stringify(submitted.body).slice(0, 300)}`);
  const jobId = submitted.body?.background_job_id;
  if (!jobId) throw new Error(`pixellab returned no background_job_id: ${JSON.stringify(submitted.body).slice(0, 300)}`);

  let job: any = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`pixellab generation timed out after ${opts.timeoutMs} ms (job ${jobId})`);
    const poll = await httpJson(fetchImpl, `${base}/v2/background-jobs/${jobId}`, { headers: { authorization: `Bearer ${key}` } });
    if (poll.status >= 400)
      throw new Error(`pixellab job poll failed (${poll.status}): ${poll.body?.detail ?? JSON.stringify(poll.body).slice(0, 300)}`);
    if (poll.body?.status === "failed")
      throw new Error(`pixellab job failed: ${JSON.stringify(poll.body?.last_response ?? poll.body).slice(0, 300)}`);
    if (poll.body?.status === "completed") {
      job = poll.body;
      break;
    }
    await sleep(opts.pollIntervalMs ?? 2000);
  }

  const b64s: string[] = [];
  collectBase64Images(job?.last_response, b64s);
  if (b64s.length === 0) throw new Error("pixellab job completed but carried no image payload");
  const written = await writeImages(opts.workspace, input.out, b64s.map((b64) => [new Uint8Array(Buffer.from(b64, "base64"))]));

  const usage = (job?.usage ?? submitted.body?.usage) as { type?: string; usd?: number } | null | undefined;
  const reportedUsd = usage?.type === "usd" && typeof usage.usd === "number" ? usage.usd : undefined;
  const costUsd = reportedUsd ?? PIXELLAB_ESTIMATE_USD;
  return {
    provider: "pixellab",
    images: written,
    cost_micro_usd: usdToMicro(costUsd),
    cost_source: reportedUsd === undefined ? "estimated" : "reported",
    metadata: { background_job_id: jobId, usage: usage ?? null, created_at: job?.created_at },
  };
}
