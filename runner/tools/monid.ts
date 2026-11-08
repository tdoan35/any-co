// Monid (monid.ai) tool marketplace (T50): discover / inspect / run paid endpoints (video generation and more), billed to the
// studio's Monid wallet. Plain HTTP against the documented API (base https://api.monid.ai, `Authorization: Bearer <key>`;
// POST /v1/discover, POST /v1/inspect, POST /v1/run, GET /v1/runs/:runId), the same calls @monid-ai/cli 0.1.9 makes.
// Files go up through Monid's free `sfs` provider: run sfs /put → PUT the bytes to the signed uploadUrl → run sfs /cat → URL.
//
// Key: MONID_API_KEY from env only. It goes in the Authorization header of api.monid.ai calls and nowhere else (never to a
// signed URL or a download host), and every result and error is passed through redact().
// Spend (deterministic, like T44's OpenAI image cap): MONID_CAP_USD per studio per day (default 25) over the monid_* lines in
// runs/spend.jsonl; a run estimated over MONID_APPROVAL_USD (default 3) goes through the approval gate (approvalWhen); the
// reported cost is charged to the run (cost_micro_usd → spend.jsonl + run budget); a ledger decision at 80% and at the cap.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { blockedHost, clip, errText, resolveInWorkspace, type ToolContext, type ToolImpl, type ToolOutput } from "./kit.ts";
import { SpendLedger, periodStart } from "../spend.ts";
import { append as ledgerAppend, read as ledgerRead, LEDGER_FILE } from "../../tools/ledger/ledger.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MONID_DEFAULT_BASE = "https://api.monid.ai";
export const MONID_DEFAULT_CAP_USD = 25;
export const MONID_DEFAULT_APPROVAL_USD = 3;
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);
/** Poll pacing for runs that answer RUNNING (tests shrink it). */
export const MONID_POLL = { firstMs: 2000, maxMs: 10_000 };
/** Media only: what a clip pipeline needs to upload or download (keeps notes, keys and code out of the wallet's storage). */
const MEDIA_EXT = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".gif", ".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".m4a", ".ogg"]);
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const SECRET_NAME = /(^|\/)\.env|\.pem$|id_rsa|credentials/i;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};
export const monidCapUsd = (env = process.env) => num(env.MONID_CAP_USD, MONID_DEFAULT_CAP_USD);
export const monidApprovalUsd = (env = process.env) => num(env.MONID_APPROVAL_USD, MONID_DEFAULT_APPROVAL_USD);
const baseUrl = () => (process.env.MONID_API_BASE_URL || MONID_DEFAULT_BASE).replace(/\/+$/, "");
const apiKey = () => process.env.MONID_API_KEY?.trim() || "";

/** Strip the key (and anything shaped like a Monid key or a bearer token) from text that leaves the tool. */
export function redact(s: string): string {
  const key = apiKey();
  let out = key ? s.split(key).join("[redacted]") : s;
  out = out.replace(/monid_[a-z]+_[A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g, "Bearer [redacted]");
  return out;
}
const fail = (msg: string): ToolOutput => ({ content: clip(redact(msg)), is_error: true });
const ok = (data: unknown, cost_micro_usd = 0): ToolOutput => ({ content: clip(redact(JSON.stringify(data, null, 2))), cost_micro_usd });

// ---------- the HTTP client ----------
class MonidHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function api(method: "GET" | "POST", p: string, body?: unknown, opts: { acceptRunBody?: boolean } = {}): Promise<any> {
  const res = await fetch(baseUrl() + p, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "X-Monid-Client": "any-co-harness" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = res.status === 204 ? "" : await res.text();
  let data: any = undefined;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {}
  if (!res.ok) {
    // POST /v1/run can answer non-2xx with a run body (a provider error after the run was created): that is a result, not an error
    if (opts.acceptRunBody && data && typeof data === "object" && "runId" in data && "status" in data) return data;
    const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`;
    throw new MonidHttpError(res.status, `Monid ${method} ${p} failed (${res.status}${res.status === 401 ? ", key refused" : res.status === 402 ? ", wallet balance too low" : ""}): ${msg}`);
  }
  if (data === undefined) throw new MonidHttpError(res.status, `Monid ${method} ${p}: expected JSON, got ${raw.slice(0, 80) || "an empty body"}`);
  return data;
}

/** "apify/apidojo/tweet-scraper" → { provider: "apify", endpoint: "/apidojo/tweet-scraper" } (tool_id = provider + endpoint). */
export function parseToolId(id: string): { provider: string; endpoint: string } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\/\S*)$/.exec(id.trim());
  return m ? { provider: m[1], endpoint: m[2] } : null;
}
const toolIdOf = (r: { provider?: string; endpoint?: string }) => `${r.provider ?? "?"}${r.endpoint ?? ""}`;

// ---------- prices and costs ----------
function amountValue(a: unknown): number | null {
  if (typeof a === "number" && Number.isFinite(a)) return a;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    if (o.per !== undefined && o.per !== null) return null; // per N tokens/seconds/...: depends on the input, not boundable here
    if ("amount" in o) return amountValue(o.amount);
    if (typeof o.value === "number") return o.value;
  }
  return null;
}

/**
 * A USD upper bound for ONE call from an inspect/discover `price`, or null when it depends on the input (per result, per unit,
 * per second, metered, unknown shapes). Only fixed prices are trusted: PER_CALL (+ flatFee), a TIERED price whose base and
 * every tier are fixed (all tiers summed), a PER_UNIT_MATRIX whose variants are all fixed (the dearest variant).
 */
export function priceEstimateUsd(price: unknown): number | null {
  if (!price || typeof price !== "object") return null;
  const p = price as Record<string, any>;
  const flat = p.flatFee == null ? 0 : amountValue(p.flatFee);
  if (flat === null) return null;
  if (p.type === "PER_CALL") {
    const a = amountValue(p.amount);
    return a === null ? null : a + flat;
  }
  if (p.type === "TIERED") {
    const parts = [p.default, ...(Array.isArray(p.tiers) ? p.tiers.map((t: any) => t?.price) : [])].map((x) =>
      x && typeof x === "object" && x.type && x.type !== "PER_CALL" ? null : amountValue(x),
    );
    return parts.some((x) => x === null) ? null : parts.reduce((s: number, x) => s + (x as number), 0) + flat;
  }
  if (p.type === "PER_UNIT_MATRIX" && Array.isArray(p.variants) && p.variants.length) {
    const vals: Array<number | null> = p.variants.map((v: any) => amountValue(v?.price ?? v?.amount));
    return vals.some((x) => x === null) ? null : Math.max(...(vals as number[])) + flat;
  }
  return null;
}

/** The cost Monid reports for a run, in USD: billing.reportedCost (MICRO_DOLLAR), else cost {value USD}, else billing.calculatedCost; null if none. */
export function reportedCostUsd(r: any): number | null {
  const money = (c: any): number | null => {
    if (!c || typeof c !== "object" || typeof c.value !== "number" || !Number.isFinite(c.value)) return null;
    if (c.unit === "MICRO_DOLLAR") return c.value / 1e6;
    if (c.unit === undefined && (c.currency === undefined || c.currency === "USD")) return c.value;
    return null; // an unknown unit is not guessed at: the caller charges the estimate instead
  };
  return money(r?.billing?.reportedCost) ?? money(r?.cost) ?? money(r?.billing?.calculatedCost);
}

const runOutput = (r: any) => r?.providerResponse?.data ?? r?.output ?? r?.providerResponse?.error ?? null;

// ---------- studio state: day spend (spend.jsonl), charged runs (runs/monid-runs.json) ----------
const runsDirOf = (ctx: ToolContext) => ctx.runsDir ?? path.join(ROOT, "runs");

/** USD charged to Monid tools today (local day) in this studio's spend ledger. */
export function monidSpentTodayUsd(runsDir: string, now = new Date()): number {
  const t = periodStart("day", now).getTime();
  const micro = new SpendLedger(path.join(runsDir, "spend.jsonl"))
    .entries()
    .filter((e) => e.kind === "tool" && e.what.startsWith("monid_") && Date.parse(e.ts) >= t)
    .reduce((s, e) => s + e.micro_usd, 0);
  return micro / 1e6;
}

interface ChargedRun { tool_id: string; agent: string; run_id: string; estimate_usd: number; charged_micro: number; status: string; ts: string }
const stateFile = (runsDir: string) => path.join(runsDir, "monid-runs.json");
function readState(runsDir: string): Record<string, ChargedRun> {
  try {
    return JSON.parse(readFileSync(stateFile(runsDir), "utf8")).runs ?? {};
  } catch {
    return {};
  }
}
function writeState(runsDir: string, runs: Record<string, ChargedRun>): void {
  mkdirSync(runsDir, { recursive: true });
  const f = stateFile(runsDir);
  writeFileSync(f + ".tmp", JSON.stringify({ runs }, null, 2));
  renameSync(f + ".tmp", f);
}

/** ONE ledger decision per studio per day at 80% of MONID_CAP_USD and one at the cap (deduplicated by refs). */
function noteSpend(ctx: ToolContext, spentUsd: number, capUsd: number): string | null {
  const threshold = spentUsd >= capUsd ? "cap" : spentUsd >= 0.8 * capUsd ? "80" : null;
  if (!threshold) return null;
  const ledgerFile = ctx.ledgerFile ?? LEDGER_FILE;
  const ref = `monid-spend:${periodStart("day").toISOString().slice(0, 10)}:${threshold}`;
  if (ledgerRead(ledgerFile).some((e) => e.kind === "decision" && e.topic === "spend.monid" && (e.refs ?? []).includes(ref))) return threshold;
  ledgerAppend({
    kind: "decision", ts: new Date().toISOString(), agent: ctx.agent ?? "monid", run_id: ctx.run_id ?? "unknown", topic: "spend.monid",
    decision: threshold === "cap"
      ? `Monid spend is at today's cap: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} (MONID_CAP_USD); further monid runs are refused until tomorrow`
      : `Monid spend passed 80% of today's cap: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} (MONID_CAP_USD)`,
    rationale: "Paid Monid endpoints are capped per studio per day in code (runner/tools/monid.ts); game footage from media_capture is free.",
    refs: [ref],
  }, ledgerFile);
  return threshold;
}

// ---------- estimates (inspect is free; cached briefly so the approval check and the run share one call) ----------
const inspectCache = new Map<string, { at: number; data: any }>();
async function inspect(provider: string, endpoint: string): Promise<any> {
  const k = `${baseUrl()} ${provider}${endpoint}`;
  const hit = inspectCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const data = await api("POST", "/v1/inspect", { provider, endpoint });
  inspectCache.set(k, { at: Date.now(), data });
  return data;
}
export const clearMonidCache = () => inspectCache.clear();

/** The estimate the gates use: the inspect price when it is fixed, else the caller's max_usd. */
async function estimateFor(provider: string, endpoint: string, maxUsd: number): Promise<{ usd: number; from: "price" | "max_usd"; price: unknown }> {
  try {
    const data = await inspect(provider, endpoint);
    const est = priceEstimateUsd(data?.price);
    return est === null ? { usd: maxUsd, from: "max_usd", price: data?.price ?? null } : { usd: est, from: "price", price: data.price };
  } catch {
    return { usd: maxUsd, from: "max_usd", price: null };
  }
}

async function poll(runId: string, waitS: number): Promise<any> {
  const deadline = Date.now() + waitS * 1000;
  let delay = MONID_POLL.firstMs;
  for (;;) {
    const r = await api("GET", `/v1/runs/${encodeURIComponent(runId)}`);
    if (TERMINAL.has(r?.status) || Date.now() + delay > deadline) return r;
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 1.5, MONID_POLL.maxMs);
  }
}

/**
 * Charge what a run costs, once: on a terminal status the reported cost (or the estimate when none is reported); while it
 * is still running, the estimate as a reservation. Later calls only charge the difference upward, so polling never
 * double-charges and a reservation is never refunded below what was charged.
 */
function settle(ctx: ToolContext, r: any, est: { tool_id: string; usd: number } | null): { charge_micro: number; charged_usd: number; cost_usd: number | null; tracked: boolean } {
  const runsDir = runsDirOf(ctx);
  const runs = readState(runsDir);
  const prev = runs[r.runId];
  if (!prev && !est) return { charge_micro: 0, charged_usd: 0, cost_usd: reportedCostUsd(r), tracked: false };
  const estimateUsd = prev?.estimate_usd ?? est!.usd;
  const terminal = TERMINAL.has(r.status);
  const cost = reportedCostUsd(r);
  const owed = Math.round((terminal ? cost ?? estimateUsd : Math.max(cost ?? 0, estimateUsd)) * 1e6);
  const already = prev?.charged_micro ?? 0;
  const charge = Math.max(0, owed - already);
  runs[r.runId] = {
    tool_id: prev?.tool_id ?? est!.tool_id, agent: prev?.agent ?? ctx.agent ?? "unknown", run_id: prev?.run_id ?? ctx.run_id ?? "unknown",
    estimate_usd: estimateUsd, charged_micro: already + charge, status: String(r.status), ts: new Date().toISOString(),
  };
  writeState(runsDir, runs);
  return { charge_micro: charge, charged_usd: (already + charge) / 1e6, cost_usd: cost, tracked: true };
}

function runSummary(r: any) {
  return {
    monid_run_id: r?.runId,
    tool_id: toolIdOf(r ?? {}),
    status: r?.status,
    provider_http_status: r?.providerResponse?.httpStatus ?? null,
    error: r?.error ?? r?.providerResponse?.error ?? null,
    output: runOutput(r),
  };
}

// ---------- tools ----------
const noKey = () => fail("MONID_API_KEY is not set in the studio's environment; Monid tools are unavailable (no request was made).");

const monidDiscover: ToolImpl = {
  description:
    "Search the Monid tool marketplace (monid.ai: video generation, image, data endpoints) in plain words. Free. Returns tool_id (provider + endpoint), description, price, and a fixed-price estimate when the price does not depend on the input.",
  input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).default(8) }).strict(),
  async run({ query, limit }) {
    if (!apiKey()) return noKey();
    try {
      const d = await api("POST", "/v1/discover", { query, limit });
      const results = (Array.isArray(d?.results) ? d.results : []).map((r: any) => ({
        tool_id: toolIdOf(r), provider_name: r.providerName ?? null, description: r.description ?? "", price: r.price ?? null,
        estimate_usd: priceEstimateUsd(r.price), health: r.metrics?.status ?? null,
      }));
      return ok({ query, count: results.length, results, next: "monid_inspect a tool_id for its input fields and pricing before monid_run" });
    } catch (e) {
      return fail(errText(e));
    }
  },
};

const monidInspect: ToolImpl = {
  description:
    "Inspect one Monid tool (tool_id from monid_discover): its input fields, pricing and notes. Free. estimate_usd is null when the price depends on the input; then monid_run charges against your max_usd.",
  input: z.object({ tool_id: z.string().min(2).max(200) }).strict(),
  async run({ tool_id }) {
    if (!apiKey()) return noKey();
    const id = parseToolId(tool_id);
    if (!id) return fail(`tool_id must be <provider>/<endpoint path>, e.g. "apify/apidojo/tweet-scraper"; got "${tool_id}"`);
    try {
      const d = await inspect(id.provider, id.endpoint);
      return ok({
        tool_id, provider_name: d.providerName ?? null, description: d.description ?? "", summary: d.summary ?? null, price: d.price ?? null,
        estimate_usd: priceEstimateUsd(d.price), input: d.input ?? d.inputSchema ?? null, notes: d.notes ?? [], doc_url: d.docUrl ?? null,
        approval_over_usd: monidApprovalUsd(),
      });
    } catch (e) {
      return fail(errText(e));
    }
  },
};

const runInput = z
  .object({
    tool_id: z.string().min(2).max(200).describe("<provider>/<endpoint path> from monid_discover"),
    inputs: z.record(z.string(), z.unknown()).default({}).describe("The endpoint's body fields (see monid_inspect)"),
    query: z.record(z.string(), z.unknown()).optional().describe("Query parameters, only if monid_inspect lists any"),
    path_params: z.record(z.string(), z.unknown()).optional().describe("Path parameters, only if monid_inspect lists any"),
    max_usd: z.number().positive().max(100).describe("The most this run may cost. Refused if the fixed price is higher; used as the estimate when the price depends on the input"),
    wait_s: z.number().int().min(0).max(540).default(240).describe("Seconds to wait for completion; a still-running run is checked later with monid_run_get"),
  })
  .strict();
type RunInput = z.infer<typeof runInput>;

const monidRun: ToolImpl = {
  description:
    "Run a PAID Monid tool (e.g. a video generation endpoint) with your inputs. Capped per studio per day (MONID_CAP_USD); a run estimated over MONID_APPROVAL_USD waits for human approval. The cost is charged to your budget. Media inputs are URLs: get one for a workspace file with monid_upload; save outputs with monid_download.",
  input: runInput,
  async approvalWhen(input: RunInput, ctx: ToolContext) {
    const id = parseToolId(input.tool_id);
    if (!apiKey() || !id) return null; // run() refuses these without a request
    const cap = monidCapUsd();
    if (monidSpentTodayUsd(runsDirOf(ctx)) >= cap) return null; // run() refuses at the cap
    const est = await estimateFor(id.provider, id.endpoint, input.max_usd);
    const threshold = monidApprovalUsd();
    return est.usd > threshold
      ? `monid run ${input.tool_id} estimated $${est.usd.toFixed(2)} (${est.from === "price" ? "fixed price" : "max_usd, price varies"}) is over MONID_APPROVAL_USD $${threshold.toFixed(2)}`
      : null;
  },
  async run(input: RunInput, ctx: ToolContext) {
    if (!apiKey()) return noKey();
    const id = parseToolId(input.tool_id);
    if (!id) return fail(`tool_id must be <provider>/<endpoint path>; got "${input.tool_id}" (no request was made)`);
    const runsDir = runsDirOf(ctx);
    const cap = monidCapUsd();
    const spent = monidSpentTodayUsd(runsDir);
    if (spent >= cap) {
      noteSpend(ctx, spent, cap);
      return fail(`refused: Monid spend today is $${spent.toFixed(2)}, at MONID_CAP_USD $${cap.toFixed(2)} (no request was made). Use game footage from media_capture instead.`);
    }
    const est = await estimateFor(id.provider, id.endpoint, input.max_usd);
    if (est.from === "price" && est.usd > input.max_usd)
      return fail(`refused: ${input.tool_id} costs $${est.usd.toFixed(4)} per call, over your max_usd $${input.max_usd} (no run was made)`);
    if (spent + est.usd > cap)
      return fail(`refused: $${spent.toFixed(2)} spent today + this run's estimate $${est.usd.toFixed(2)} is over MONID_CAP_USD $${cap.toFixed(2)} (no run was made)`);
    const reqInput: Record<string, unknown> = {};
    if (Object.keys(input.inputs).length) reqInput.body = input.inputs;
    if (input.query && Object.keys(input.query).length) reqInput.queryParams = input.query;
    if (input.path_params && Object.keys(input.path_params).length) reqInput.pathParams = input.path_params;
    let r: any;
    try {
      // POST /v1/run is never retried: it is paid, and a lost response may still have created the run
      r = await api("POST", "/v1/run", { provider: id.provider, endpoint: id.endpoint, ...(Object.keys(reqInput).length ? { input: reqInput } : {}) }, { acceptRunBody: true });
    } catch (e) {
      const lost = !(e instanceof MonidHttpError);
      return fail(`${errText(e)}${lost ? " — no response, so the run may or may not exist; nothing was charged here. Do not repeat it blindly." : ""}`);
    }
    try {
      if (!TERMINAL.has(r.status) && input.wait_s > 0) r = await poll(r.runId, input.wait_s);
    } catch {
      // keep the create response; the reservation below still holds the estimate
    }
    const s = settle(ctx, r, { tool_id: input.tool_id, usd: est.usd });
    const after = spent + s.charge_micro / 1e6;
    const note = noteSpend(ctx, after, cap);
    return ok({
      ...runSummary(r), tool_id: input.tool_id,
      cost_usd: s.cost_usd, charged_usd: s.charged_usd, estimate_usd: est.usd, estimate_from: est.from,
      over_max_usd: s.cost_usd !== null && s.cost_usd > input.max_usd,
      spent_today_usd: Number(after.toFixed(6)), cap_usd: cap, ...(note ? { cap_note: note === "cap" ? "at today's cap" : "past 80% of today's cap" } : {}),
      next: TERMINAL.has(r.status) ? "save output files with monid_download" : "still running: check it with monid_run_get (the estimate is reserved against the cap)",
    }, s.charge_micro);
  },
};

const monidRunGet: ToolImpl = {
  description: "Check a Monid run started by monid_run (status, output, cost). Free; when it finishes, its reported cost settles against the reserved estimate.",
  input: z.object({ run_id: z.string().min(1).max(120), wait_s: z.number().int().min(0).max(540).default(0) }).strict(),
  async run({ run_id, wait_s }, ctx) {
    if (!apiKey()) return noKey();
    try {
      const r = wait_s > 0 ? await poll(run_id, wait_s) : await api("GET", `/v1/runs/${encodeURIComponent(run_id)}`);
      const s = settle(ctx, r, null);
      const cap = monidCapUsd();
      const after = monidSpentTodayUsd(runsDirOf(ctx)) + s.charge_micro / 1e6;
      if (s.charge_micro) noteSpend(ctx, after, cap);
      return ok({ ...runSummary(r), cost_usd: s.cost_usd, charged_usd: s.charged_usd, tracked: s.tracked, spent_today_usd: Number(after.toFixed(6)), cap_usd: cap }, s.charge_micro);
    } catch (e) {
      return fail(errText(e));
    }
  },
};

/** A workspace media file the tools may move: inside the run workspace (realpath), regular, media extension, not secret-shaped. */
async function workspaceMedia(ctx: ToolContext, rel: string, mustExist: boolean): Promise<string> {
  if (SECRET_NAME.test(rel)) throw new Error(`refused: ${rel} looks like a secret`);
  if (!MEDIA_EXT.has(path.extname(rel).toLowerCase())) throw new Error(`refused: only media files (${[...MEDIA_EXT].join(" ")}), got ${rel}`);
  const abs = resolveInWorkspace(ctx.workspace, rel);
  if (mustExist) {
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new Error(`not a file in your workspace: ${rel}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`refused: ${rel} is ${st.size} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
  }
  return abs;
}

/** URLs Monid hands back (signed upload URLs, outputs) must be https on a public host; the configured API origin is allowed too (tests). */
function fetchableUrl(u: string): URL {
  const url = new URL(u);
  const sameOrigin = url.origin === new URL(baseUrl()).origin;
  if (!sameOrigin && (url.protocol !== "https:" || blockedHost(url.hostname))) throw new Error(`refused: ${url.protocol}//${url.hostname} is not a public https host`);
  return url;
}

async function sfs(endpoint: "/put" | "/cat", body: Record<string, unknown>): Promise<{ out: any; run: any }> {
  let r = await api("POST", "/v1/run", { provider: "sfs", endpoint, input: { body } }, { acceptRunBody: true });
  if (!TERMINAL.has(r.status)) r = await poll(r.runId, 60);
  if (r.status !== "COMPLETED" || (r.providerResponse?.httpStatus ?? 200) >= 400) throw new Error(`sfs ${endpoint} did not complete (${r.status}): ${JSON.stringify(r.error ?? r.providerResponse?.error ?? null)}`);
  return { out: runOutput(r), run: r };
}

const monidUpload: ToolImpl = {
  description:
    "Upload a media file from your workspace (e.g. media/clip.mp4 from media_capture, or upstream/<card>/...) to the studio's Monid file storage and get a temporary URL to pass as a Monid tool input. Free.",
  input: z
    .object({
      path: z.string().min(1).max(300).describe("Workspace path of an mp4/mov/webm/gif/png/jpg/webp/audio file"),
      ttl: z.enum(["1h", "1d", "7d"]).default("1d"),
    })
    .strict(),
  async run({ path: rel, ttl }, ctx) {
    if (!apiKey()) return noKey();
    let abs: string;
    try {
      abs = await workspaceMedia(ctx, rel, true);
    } catch (e) {
      return fail(`${errText(e)} (no request was made)`);
    }
    try {
      const bytes = await readFile(abs);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const remote = `any-co/${ctx.run_id ?? "manual"}/${sha.slice(0, 12)}-${path.basename(abs)}`;
      const put = await sfs("/put", { path: remote, sizeBytes: bytes.length });
      const uploadUrl = fetchableUrl(String(put.out?.uploadUrl ?? ""));
      const up = await fetch(uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Length": String(bytes.length) }, signal: AbortSignal.timeout(300_000) });
      if (!up.ok) return fail(`upload of ${rel} failed: HTTP ${up.status} from the signed URL`);
      const cat = await sfs("/cat", { path: remote, ttl });
      const cost = (reportedCostUsd(put.run) ?? 0) + (reportedCostUsd(cat.run) ?? 0);
      return ok({ path: rel, bytes: bytes.length, sha256: sha, remote_path: remote, url: cat.out?.url ?? null, expires_at: cat.out?.expiresAt ?? null }, Math.round(cost * 1e6));
    } catch (e) {
      return fail(errText(e));
    }
  },
};

const monidDownload: ToolImpl = {
  description:
    "Save a media file a Monid run produced (a URL from its output) into your workspace, e.g. media/monid/hook-1.mp4, so media_probe/media_edit can use it. Free. Media types only.",
  input: z.object({ url: z.string().url().max(4000), out: z.string().min(1).max(300) }).strict(),
  async run({ url, out }, ctx) {
    let abs: string;
    let u: URL;
    try {
      abs = await workspaceMedia(ctx, out, false);
      u = fetchableUrl(url);
    } catch (e) {
      return fail(`${errText(e)} (no request was made)`);
    }
    try {
      const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(300_000) }); // no auth header: these are signed/public URLs
      if (res.url && res.url !== u.href) fetchableUrl(res.url);
      if (!res.ok) return fail(`download failed: HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_FILE_BYTES) return fail(`refused: ${len} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) return fail(`refused: ${bytes.length} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      return ok({ path: out, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), content_type: res.headers.get("content-type") });
    } catch (e) {
      return fail(errText(e));
    }
  },
};

export const monidTools: Record<string, ToolImpl> = {
  monid_discover: monidDiscover,
  monid_inspect: monidInspect,
  monid_run: monidRun,
  monid_run_get: monidRunGet,
  monid_upload: monidUpload,
  monid_download: monidDownload,
};

/** For tests and studio_status: is there state on disk. */
export const monidStateExists = (runsDir: string) => existsSync(stateFile(runsDir));
