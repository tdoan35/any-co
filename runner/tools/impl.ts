// Local implementations of the capabilities in registry.ts.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CORE_CAPABILITIES, CapabilityName } from "./registry.ts";
import { LANES } from "./lanes/index.ts";
import { mergeImpls } from "./lanes/merge.ts";
import { MAX_RESULT_CHARS, clip, errText, lstatOk, realOrNull, resolveInWorkspace, type ToolContext, type ToolImpl, type ToolOutput } from "./kit.ts";
import type { NaiveClient } from "../providers.ts";
import { studioStatusTools } from "./studio-status.ts";
import { decodePng, encodePng, type RgbaImage } from "../../tools/art/png.ts";
import { addOutline, contactSheet, lockPalette, snapToGrid, splitStrip, upscaleNearest } from "../../tools/art/ops.ts";
import { runGate } from "../../tools/art/gate.ts";
import { ChargedFailure, DEFAULT_CANDIDATES, MAX_CANDIDATES, ProviderExhausted, ProviderUnavailable, balance as providerBalance, generate, type Balance, isAnimation, quote as providerQuote, type GenerateResult, type ProviderName } from "../../tools/art/generate.ts";
import {
  LOW_GENERATIONS, MAX_REGENERATIONS, PROVIDERS, anchorWinner, checkPixellabFloor, pixellabCallEstimate, pixellabFloor, type FloorVerdict, countGeneration, generationCount, isExhausted, markExhausted, other, readCredits, readGallery,
  readProviders, recordAnchorWinner, recordCredit, statePaths,
} from "../../tools/art/credits.ts";
import { capture as mediaCapture, POLICY as MEDIA_POLICY, type CaptureMode } from "../../tools/media/capture.ts";
import { edit as mediaEdit, probe as mediaProbe } from "../../tools/media/edit.ts";
import { track as trackGroup } from "../../tools/proc/reaper.ts";
import { append as ledgerAppend, read as ledgerRead, LEDGER_FILE, type LedgerEntry } from "../../tools/ledger/ledger.ts";
import { GALLERY_DIR, nextGalleryOrdinal, recordGalleryImage } from "../../tools/art/gallery.ts";
import type { ImageBlock } from "../types.ts";
import { AGENTS_DIR } from "../load.ts";
import type { Board } from "../board/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Tool types and the helpers lane modules may use live in ./kit.ts (lanes must never import this file).
export type { ToolContext, ToolOutput, ToolImpl } from "./kit.ts";
export { clip, errText, resolveInWorkspace } from "./kit.ts";

// ---------- catalog_query: one tool per command ----------
// One tool per command, each with only its own fields: a single tool with every optional field made
// models send stray arguments and drop required ones (see docs/decisions.md, Nov 6 eval runs).

/** Re-serialize JSON without indentation: same data, far fewer tokens. */
export function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
      resolve({ out: String(stdout), err: String(stderr), code });
    });
  });
}

/** Run tools/catalog/query.py with an argv; returns compact JSON text. */
export async function runCatalog(argv: string[]): Promise<ToolOutput> {
  const script = path.join(ROOT, "tools", "catalog", "query.py");
  const { out, err, code } = await execText("python3", ["-I", script, ...argv], 120_000);
  if (code !== 0) return { content: clip(`catalog query failed (exit ${code}): ${err || out}`, 4000), is_error: true };
  return { content: clip(compactJson(out.trim())) };
}

// Tags as "A, B" or ["A", "B"]; models handle a plain string more reliably.
const tagList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => {
    // Accept "A, B", ["A", "B"], and a JSON list sent as a string ('["A", "B"]').
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try { const j = JSON.parse(v); if (Array.isArray(j)) v = j.map(String); } catch { /* fall through to comma split */ }
    }
    return (Array.isArray(v) ? v : v.split(",")).map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  })
  .refine((v) => v.length >= 1 && v.length <= 3, "give 1 to 3 tags")
  .describe('Exact tag names, comma-separated, e.g. "Roguelike Deckbuilder, Pixel Graphics"');
const limit = z.number().int().positive().max(200).optional().describe("Max rows to return");
const minSupply = z.number().int().positive().optional().describe("Minimum releases in the window (default 50 for tags, 30 for pairs)");

const opt = (flag: string, v: unknown) => (v === undefined || v === "" ? [] : [flag, String(v)]);

const catalogTools: Record<string, ToolImpl> = {
  catalog_meta: {
    description: "Catalog snapshot facts: snapshot date, tag coverage end, the 24-month analysis window, and baseline stats. Call this first.",
    input: z.object({}).strict(),
    run: () => runCatalog(["meta"]),
  },
  catalog_find_tags: {
    description: "Find exact tag spellings matching some text (tags are case-sensitive).",
    input: z.object({ q: z.string().min(1).describe("Text to match, e.g. 'rogue'") }).strict(),
    run: ({ q }) => runCatalog(["find-tags", "--q", q]),
  },
  catalog_tags: {
    description: "Every tag ranked by opportunity (demand percentile × (1 − supply percentile)) over the analysis window.",
    input: z.object({ min: minSupply, limit }).strict(),
    run: ({ min, limit }) => runCatalog(["tags", ...opt("--min", min), ...opt("--limit", limit)]),
  },
  catalog_pairs: {
    description: "Tag pairs ranked by opportunity. Give base to see only pairs containing that tag. Very common tags (Indie, 2D, ...) are skipped unless keep_broad is true.",
    input: z.object({ base: z.string().optional().describe("Only pairs containing this exact tag"), min: minSupply, limit, keep_broad: z.boolean().optional() }).strict(),
    run: ({ base, min, limit, keep_broad }) =>
      runCatalog(["pairs", ...opt("--base", base), ...opt("--min", min), ...opt("--limit", limit), ...(keep_broad ? ["--keep-broad"] : [])]),
  },
  catalog_niche: {
    description: "Profile of the games having ALL of 1–3 tags: window_stats (supply, traction, demand, percentiles, opportunity), yearly trend, top games. Cite window_stats from here.",
    input: z.object({ tags: tagList, limit }).strict(),
    run: ({ tags, limit }) => runCatalog(["niche", "--tags", tags.join(","), ...opt("--limit", limit ?? 6)]),
  },
  catalog_games: {
    description: "Comparable games having ALL of 1–3 tags, most-reviewed first, with tags and a short description.",
    input: z.object({ tags: tagList, limit, since: z.string().optional().describe("Only games released on or after YYYY-MM-DD") }).strict(),
    run: ({ tags, limit, since }) => runCatalog(["games", "--tags", tags.join(","), ...opt("--limit", limit), ...opt("--since", since)]),
  },
  catalog_game: {
    description: "One game's full record by Steam appid (preferred) or name.",
    input: z
      .object({ appid: z.number().int().optional(), name: z.string().optional() })
      .strict()
      .refine((v) => v.appid !== undefined || !!v.name, "give appid or name"),
    run: ({ appid, name }) => runCatalog(["game", ...opt("--appid", appid), ...opt("--name", appid === undefined ? name : undefined)]),
  },
};

// ---------- gap_map (tools/gapmap) ----------
const gapTools: Record<string, ToolImpl> = {
  gapmap_regions: {
    description:
      "Ranked regions of the Steam embedding map. A region is a cluster of similar releases (by tags, genres, and " +
      "description): a niche tags alone can't express. Scored like a catalog tag over the same window: supply, traction, " +
      "opportunity = demand_pct × (1 − supply_pct); after_window = releases since (competition arriving now); cohesion " +
      "(low = mixed bag); indie_share (low = AAA niche). Filters: tag, min_supply, min_cohesion, min_indie_share; page with offset.",
    input: z.object({
      limit: z.number().int().positive().max(40).optional(),
      offset: z.number().int().nonnegative().optional(),
      tag: z.string().optional(),
      min_supply: z.number().int().optional(),
      min_cohesion: z.number().optional(),
      min_indie_share: z.number().optional().describe("e.g. 0.4 to skip AAA niches a small studio can't reach"),
    }).strict(),
    async run(i) {
      const { regions } = await import("../../tools/gapmap/query.ts");
      return { content: JSON.stringify(regions(i)) };
    },
  },
  gapmap_region: {
    description: "Full detail for one region: window stats, top tags with shares, top games all time, the most-reviewed recent games, and its adjacent regions (nearest neighboring niches, with their stats).",
    input: z.object({ id: z.number().int().positive() }).strict(),
    async run({ id }) {
      const { region } = await import("../../tools/gapmap/query.ts");
      const r: any = region(id);
      return { content: JSON.stringify(r), is_error: !!r.error };
    },
  },
  gapmap_probe: {
    description:
      "Place a free-text description of a market segment on the map: its 10 nearest real games, novelty_pct (farther " +
      "from its nearest game than this share of real games are), and the region it falls in with that region's stats. " +
      "Use it to test whether a gap is really open and what market it sits in. " +
      "Describe the core loop, setting, and hook in 1–3 sentences.",
    input: z.object({ text: z.string().min(20).max(1500) }).strict(),
    async run({ text }) {
      const { probe } = await import("../../tools/gapmap/query.ts");
      try {
        const { result, cost_micro_usd } = await probe(text);
        return { content: JSON.stringify(result), cost_micro_usd };
      } catch (e: any) {
        return { content: `probe failed: ${e?.message ?? e}`, is_error: true };
      }
    },
  },
};

// ---------- steam_reviews (tools/steam-reviews) ----------
const appid = z.number().int().positive().describe("Steam appid");
const kind = z.enum(["negative", "positive"]);
const reviewTools: Record<string, ToolImpl> = {
  reviews_fetch: {
    description:
      "Read a sample of a game's Steam reviews (English, most helpful first unless sort is mostrecent). Returns sample stats " +
      "(median hours, share under 2 hours, early-access share) and each review's id, hours, date, helpful votes, and text " +
      "(clipped to max_chars). Cite reviews by id.",
    input: z.object({
      appid, kind,
      sort: z.enum(["toprated", "mostrecent"]).optional(),
      n: z.number().int().min(1).max(40).optional().describe("Reviews to return (default 20)"),
      max_chars: z.number().int().min(100).max(1500).optional().describe("Clip each review's text (default 500)"),
    }).strict(),
    async run({ appid, kind, sort, n, max_chars }) {
      const { fetchReviews, summarize } = await import("../../tools/steam-reviews/reviews.ts");
      try {
        const s = await fetchReviews(appid, kind, sort ?? "toprated", n ?? 20);
        const clipN = max_chars ?? 500;
        return { content: JSON.stringify({ appid, kind, sort: s.sort, ...summarize(s.reviews), reviews: s.reviews.map((r) => ({ id: r.id, hours: r.hours, posted: r.posted, helpful: r.helpful, early_access: r.early_access, text: r.text.length > clipN ? r.text.slice(0, clipN) + "…" : r.text })) }) };
      } catch (e: any) {
        return { content: `reviews_fetch failed: ${e?.message ?? e}`, is_error: true };
      }
    },
  },
  reviews_mentions: {
    description:
      "Count, in code, what share of a game's review sample (up to 100 most-helpful reviews of one kind) mentions each term. " +
      "Word-start match, case-insensitive ('bug' matches 'bugs', 'buggy'); 'a|b' counts either. Returns count, sample_size, " +
      "share, and up to 3 example snippets with review ids. Use this to size a complaint or praise before claiming it.",
    input: z.object({ appid, kind, terms: z.array(z.string().min(2).max(60)).min(1).max(12) }).strict(),
    async run({ appid, kind, terms }) {
      const { fetchReviews, mentions, MAX_REVIEWS } = await import("../../tools/steam-reviews/reviews.ts");
      try {
        const s = await fetchReviews(appid, kind, "toprated", MAX_REVIEWS);
        return { content: JSON.stringify({ appid, kind, results: mentions(s.reviews, terms) }) };
      } catch (e: any) {
        return { content: `reviews_mentions failed: ${e?.message ?? e}`, is_error: true };
      }
    },
  },
  reviews_trend: {
    description: "A game's monthly positive/negative review counts (last 24 full months) and last_6_vs_prior_6, the review-volume ratio (>1 = attention growing).",
    input: z.object({ appid }).strict(),
    async run({ appid }) {
      const { trend } = await import("../../tools/steam-reviews/reviews.ts");
      try {
        return { content: JSON.stringify(await trend(appid)) };
      } catch (e: any) {
        return { content: `reviews_trend failed: ${e?.message ?? e}`, is_error: true };
      }
    },
  },
};

// ---------- studio_ledger (tools/ledger) ----------
const ledgerTools: Record<string, ToolImpl> = {
  log_decision: {
    description:
      "Record a studio decision in the ledger, where judges and the studio window read it. One call per decision. " +
      "Include the alternatives you rejected and why, and refs (run ids or files) the decision rests on.",
    input: z.object({
      topic: z.string().min(3).max(60).describe("e.g. 'greenlight.pick', 'scope.cut'"),
      decision: z.string().min(5).max(400),
      rationale: z.string().min(20).max(1500),
      alternatives: z.array(z.object({ option: z.string().max(120), why_not: z.string().max(400) }).strict()).max(6).optional(),
      refs: z.array(z.string().max(200)).max(10).optional(),
    }).strict(),
    async run(i, ctx) {
      ledgerAppend({ kind: "decision", ts: new Date().toISOString(), agent: ctx.agent ?? "unknown", run_id: ctx.run_id ?? "unknown", ...i }, ctx.ledgerFile);
      return { content: `logged decision "${i.topic}"` };
    },
  },
  ledger_recent: {
    description:
      "Read the studio ledger: the most recent entries (newest first) and total counts of decisions and human interventions. " +
      "Use it before logging to avoid duplicates, and to report what the studio decided and when humans stepped in.",
    input: z.object({ limit: z.number().int().min(1).max(50).default(15).describe("How many recent entries to return") }).strict(),
    async run({ limit }, ctx) {
      const all = ledgerRead(ctx.ledgerFile ?? LEDGER_FILE);
      const counts = all.reduce<Record<string, number>>((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
      // A human approve/deny on the approval gate is a human intervention (rule 4); auto-approve and expiry are not.
      const human = all.filter((e) => e.kind === "approval" && e.decision !== "expired" && !e.who.startsWith("auto")).length;
      counts.intervention = (counts.intervention ?? 0) + human;
      // T17: interventions by category; those approvals count as "approval", old lines as "uncategorized".
      const interventionCategory = (e: LedgerEntry): string => {
        if (e.kind === "approval") return e.decision !== "expired" && !e.who.startsWith("auto") ? "approval" : "auto/expired";
        if (e.kind === "intervention") return e.category ?? "uncategorized";
        return "decision";
      };
      const intervention_counts = all
        .filter((e) => e.kind !== "decision")
        .reduce<Record<string, number>>((a, e) => {
          const k = interventionCategory(e);
          return ((a[k] = (a[k] ?? 0) + 1), a);
        }, {});
      return {
        content: JSON.stringify({
          total: all.length,
          counts,
          intervention_counts,
          steering: intervention_counts["steering"] ?? 0,
          recent: all.slice(-limit).reverse(),
        }),
      };
    },
  },
};

// ---------- web_fetch ----------
function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const webFetch: ToolImpl = {
  description: "Fetch a public http(s) URL and return its text (HTML is converted to plain text, long pages truncated).",
  input: z.object({ url: z.string().url(), max_chars: z.number().int().positive().max(MAX_RESULT_CHARS).optional() }).strict(),
  async run({ url, max_chars }) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { content: "invalid URL", is_error: true };
    }
    if (!["http:", "https:"].includes(u.protocol) || blockedHost(u.hostname)) {
      return { content: `refused: only public http(s) URLs (${u.protocol}//${u.hostname})`, is_error: true };
    }
    try {
      const res = await fetch(u, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "any-co-studio-agent/0.1", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
      });
      if (blockedHost(new URL(res.url).hostname)) return { content: "refused: redirected to a private host", is_error: true };
      const type = res.headers.get("content-type") ?? "";
      const raw = (await res.text()).slice(0, 3_000_000);
      const text = type.includes("html") ? htmlToText(raw) : raw;
      return {
        content: clip(`HTTP ${res.status} ${res.url}\ncontent-type: ${type}\n\n${text}`, max_chars ?? 20_000),
        is_error: !res.ok,
      };
    } catch (e: any) {
      return { content: `fetch failed: ${e?.message ?? e}`, is_error: true };
    }
  },
};

// ---------- web_search (Naïve data catalogue) ----------
// Providers in order of preference; on failure, retry once, then fall through to the next.
// Each provider's input schema is strict and different (checked with data.getTool on Nov 6).
export const SEARCH_TOOLS: Array<{ id: string; name: string; request: (q: string, n: number) => Record<string, unknown> }> = [
  { id: "6-CcN63C8HcwnyhUGBttXQx65wmuO3vXQ8FKctZ0oFTWstNLB41qkcaoW0SSbukssJAiKA", name: "Search Google ($0.00015/call)",
    request: (q, n) => ({ query: { q, num: n, fast_mode: true } }) },
  { id: "euaYQzbR_dPcu2l4X4cfTT0dGc_zpnJAtIhfewxxI_imuLrjAqWvKqEjDf-elg", name: "Search Web Pages ($0.004/call)",
    request: (q) => ({ body: { query: q } }) },
  { id: "ye6X1Obr2J8z0hsUkxqGJq3DxFv4xpn9bZXqjZNARH3gBqWZ89e8XgnrZA", name: "Web Search ($0.006/call)",
    request: (q, n) => ({ query: { q, limit: n } }) },
];

/** Pull {title, link, snippet, date} out of whichever result shape a provider returns. */
export function searchResults(data: any): Array<{ title?: string; link?: string; snippet?: string; date?: string }> {
  const rows = data?.organic_results ?? data?.results ?? data?.data ?? data?.items ?? (Array.isArray(data) ? data : []);
  return (Array.isArray(rows) ? rows : []).slice(0, 10).map((x: any) => ({
    title: x.title, link: x.link ?? x.url, snippet: x.snippet ?? x.description ?? x.content?.slice?.(0, 300), date: x.date ?? x.published_date ?? x.publishedDate,
  })).filter((r) => r.link);
}

const webSearch: ToolImpl = {
  description: "Search the web. Returns title, link, snippet, and date for each result.",
  input: z.object({ query: z.string().min(1).max(500), num: z.number().int().min(1).max(10).optional() }).strict(),
  async run({ query, num }, ctx) {
    if (!ctx.naive) return { content: "web_search needs a Naïve client (NAIVE_API_KEY)", is_error: true };
    let cost = 0;
    const failures: string[] = [];
    for (const tool of SEARCH_TOOLS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r: any = await ctx.naive.data.run({ tool_id: tool.id, ...tool.request(query, num ?? 8) });
          cost += r.cost_micro_usd ?? 0;
          if (r.status === "succeeded") {
            const results = searchResults(r.data);
            if (results.length) return { content: JSON.stringify(results), cost_micro_usd: cost };
            failures.push(`${tool.name}: no results`);
            break;
          }
          failures.push(`${tool.name}: ${r.error}`);
        } catch (e: any) {
          failures.push(`${tool.name}: ${e?.status ?? ""} ${e?.message ?? e}`);
          if (e?.status && e.status < 500 && e.status !== 429) break; // bad request: try the next provider
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return { content: `search failed on every provider (search is likely down; don't retry right away): ${failures.join(" | ").slice(0, 600)}`, is_error: true, cost_micro_usd: cost };
  },
};

// ---------- workspace_read / workspace_write ----------
// Workspace confinement: resolveInWorkspace (kit.ts).

const workspaceRead: ToolImpl = {
  description: "Read a file, or list a directory, inside your workspace. Paths are relative to the workspace root.",
  input: z.object({ path: z.string().default(".") }).strict(),
  async run({ path: rel }, ctx) {
    try {
      const p = resolveInWorkspace(ctx.workspace, rel);
      const st = await stat(p);
      if (st.isDirectory()) {
        const entries = await readdir(p, { withFileTypes: true });
        return { content: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)" };
      }
      return { content: clip(await readFile(p, "utf8")) };
    } catch (e: any) {
      return { content: String(e?.message ?? e), is_error: true };
    }
  },
};

const workspaceWrite: ToolImpl = {
  description: "Write a text file inside your workspace (creates folders, overwrites existing files).",
  input: z.object({ path: z.string().min(1), content: z.string().max(1_000_000) }).strict(),
  async run({ path: rel, content }, ctx) {
    try {
      const p = resolveInWorkspace(ctx.workspace, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
      return { content: `wrote ${path.relative(ctx.workspace, p)} (${content.length} chars)` };
    } catch (e: any) {
      return { content: String(e?.message ?? e), is_error: true };
    }
  },
};

// ---------- art_view (image_view capability) ----------
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1024;

const artView: ToolImpl = {
  description:
    "View a PNG image inside your workspace (sprite sheet, contact sheet, screenshot): the image itself is shown to you, along with its dimensions and sha256. Use it to check art against an anchor. Optional integer upscale for tiny pixel art (nearest-neighbour, output capped at 1024 px per side).",
  input: z
    .object({
      path: z.string().min(1).describe("PNG path inside the workspace, e.g. art/sheet.png"),
      upscale: z.number().int().min(1).max(8).optional().describe("Integer nearest-neighbour upscale for pixel art (max side 1024 px)"),
    })
    .strict(),
  async run({ path: rel, upscale }, ctx) {
    try {
      const p = resolveInWorkspace(ctx.workspace, rel);
      const st = await stat(p);
      if (st.size > MAX_PNG_BYTES) return { content: `image is too large: ${st.size} bytes (cap ${MAX_PNG_BYTES})`, is_error: true };
      let bytes: Uint8Array = new Uint8Array(await readFile(p));
      let img: RgbaImage = decodePng(bytes);
      const src = `${img.width}x${img.height}`;
      if (Math.max(img.width, img.height) > MAX_IMAGE_SIDE && !upscale)
        return { content: `image is ${img.width}x${img.height}: over the ${MAX_IMAGE_SIDE}px per-side cap. Make a smaller sheet (or pass \`upscale\` only on a small source).`, is_error: true };
      let scaleNote = "";
      if (upscale) {
        const k = Math.min(upscale, Math.floor(MAX_IMAGE_SIDE / Math.max(img.width, img.height)));
        if (k > 1) {
          const up = upscaleNearest(img, k);
          scaleNote = ` (${src}, x${k} nearest-neighbour)`;
          img = up;
          bytes = encodePng(img);
        }
      }
      if (bytes.length > MAX_PNG_BYTES) return { content: `encoded image is too large: ${bytes.length} bytes (cap ${MAX_PNG_BYTES}); use a smaller upscale`, is_error: true };
      // Content-addressed copy of the exact bytes sent: the transcript records the ref, a
      // resume rebuilds the message from this copy even if the workspace file changes.
      const sha = createHash("sha256").update(bytes).digest("hex");
      const runDir = path.join(ctx.runsDir ?? path.join(ROOT, "runs"), ctx.run_id ?? "manual");
      const imagesDir = path.join(runDir, "images");
      await mkdir(imagesDir, { recursive: true });
      const copy = path.join(imagesDir, `${sha}.png`);
      if (!existsSync(copy)) await writeFile(copy, bytes);
      return {
        content: `${img.width}×${img.height}${scaleNote} PNG, ${bytes.length} bytes, sha256 ${sha.slice(0, 16)}`,
        image: { type: "image", source: { type: "ref", path: copy, media_type: "image/png", sha256: sha, size: bytes.length } },
      };
    } catch (e) {
      return { content: `art_view failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
    }
  },
};

// ---------- game_repo: work on the studio's game repo (games/<name>) ----------
// Each run gets its own clone at <workspace>/game on a per-agent branch; only the Tech Lead
// merges branches into the game's main branch (single-merger rule, plan.md §6 Engineering).

/** Repo names are single slugs (new-game.ts slugify output): no dots, slashes, or absolute paths. */
const GAME_REPO_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A games/<name> entry is usable only if it is a real directory (not a symlink) whose realpath sits strictly
 *  inside realpath(root) and that holds a .git. This keeps agents from cloning, and pushing into, any repo
 *  outside games/ — the harness repo included. */
function gameRepoDir(root: string, name: string): string | null {
  const dir = path.join(root, name);
  try {
    if (!lstatSync(dir).isDirectory()) return null; // lstat: a symlink is not a directory here
    const rootReal = realpathSync(root);
    const real = realpathSync(dir);
    if (path.dirname(real) !== rootReal) return null;
  } catch {
    return null;
  }
  return existsSync(path.join(dir, ".git")) ? dir : null;
}

/** The one game repo the run works on: games/<name> (a git repo with >=1 commit). */
export function resolveGameRepo(root: string, repo?: string): { name: string; dir: string } {
  if (repo !== undefined) {
    if (!GAME_REPO_NAME.test(repo)) throw new Error(`invalid repo name "${repo}": use the bare name under games/ (lowercase letters, digits, "-")`);
    const dir = gameRepoDir(root, repo);
    if (!dir) throw new Error(`games/${repo} is not a git repo directory inside games/`);
    return { name: repo, dir };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((d) => GAME_REPO_NAME.test(d) && gameRepoDir(root, d) !== null);
  } catch {
    entries = [];
  }
  if (entries.length !== 1)
    throw new Error(
      entries.length === 0
        ? `no game repo under ${path.basename(root)}/ yet; nothing to work on`
        : `several game repos (${entries.join(", ")}); pass the repo name`,
    );
  return { name: entries[0], dir: path.join(root, entries[0]) };
}


/**
 * The run's clone on `agent/<name>`. The branch continues from origin's `agent/<name>` when one exists
 * (earlier runs pushed there), so the agent's own pushes and the end-of-run checkpoint fast-forward;
 * origin/main is then merged in (no-ff) so it starts current. A conflicting merge is aborted and the
 * branch stays at origin's tip, with a note. `base` says which start was used (T28).
 */
async function gameCloneDir(ctx: ToolContext, repo?: string): Promise<{ clone: string; branch: string; src: { name: string; dir: string }; base: string }> {
  const src = resolveGameRepo(ctx.gameRepoRoot ?? path.join(ROOT, "games"), repo);
  const clone = path.join(ctx.workspace, "game");
  const branch = `agent/${ctx.agent ?? "unknown"}`;
  let base = "existing clone (unchanged)";
  if (!existsSync(clone)) {
    const { code, err } = await execText("git", ["clone", "--quiet", src.dir, clone], 60_000);
    if (code !== 0) throw new Error(`git clone failed: ${err}`);
    const remote = `origin/${branch}`;
    const reused = (await execText("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`], 15_000)).code === 0;
    const b = await execText("git", ["-C", clone, "checkout", "--quiet", "-b", branch, ...(reused ? [remote] : [])], 30_000);
    if (b.code !== 0) throw new Error(`git checkout -b failed: ${b.err}`);
    base = "main (no earlier agent branch on origin)";
    if (reused) {
      const hasMain = (await execText("git", ["-C", clone, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], 15_000)).code === 0;
      if (!hasMain) base = `${remote} (no origin/main to merge)`;
      else {
        const id = ["-c", "user.name=any-co harness (game_clone)", "-c", "user.email=harness@any-co.invalid"];
        const m = await execText("git", ["-C", clone, ...id, "merge", "--no-ff", "--no-edit", "-q", "-m", `Merge origin/main into ${branch} (game_clone: start current)`, "origin/main"], 60_000);
        if (m.code === 0) base = `${remote} + origin/main merged in (your pushes fast-forward)`;
        else {
          await execText("git", ["-C", clone, "merge", "--abort"], 30_000);
          base = `${remote} only: merging origin/main conflicted and was aborted, so this branch is behind main. Resolve it yourself (git merge origin/main) before relying on main's latest`;
        }
      }
    }
  }
  await copyContracts(ctx.workspace);
  return { clone, branch, src, base };
}

/** The harness contracts (docs/contracts/) the game must implement, copied read-only into the run's workspace at
 *  contracts/ so game agents can read them with workspace_read. They live in this repo, which game tools can't see. */
export const CONTRACTS_DIR = path.join(ROOT, "docs", "contracts");
async function copyContracts(workspace: string) {
  const dst = path.join(workspace, "contracts");
  await mkdir(dst, { recursive: true });
  for (const f of await readdir(CONTRACTS_DIR)) {
    if (!/\.(md|json)$/.test(f)) continue;
    await writeFile(path.join(dst, f), await readFile(path.join(CONTRACTS_DIR, f)));
  }
}

const gameClone: ToolImpl = {
  description:
    "Clone the studio's game repo into this run (idempotent) on your own agent branch, and return the clone's path and branch. " +
    "Your branch continues from origin's agent/<you> when earlier runs pushed it (with origin/main merged in), so `git push origin HEAD` fast-forwards; `base` says which start was used. " +
    "Read/write/run there with game_read, game_write, game_exec. You never touch the main repo directly; the Tech Lead merges branches.",
  input: z.object({ repo: z.string().min(1).max(80).optional().describe("Repo name under games/; omit when the studio has exactly one") }).strict(),
  async run({ repo }, ctx) {
    try {
      const { clone, branch, src, base } = await gameCloneDir(ctx, repo);
      const head = await execText("git", ["-C", clone, "rev-parse", "--short", "HEAD"], 15_000);
      return {
        content: JSON.stringify({
          game: src.name, clone: path.relative(ctx.workspace, clone), branch, base, head: head.out.trim(), main: "main",
          contracts: "contracts/ in your workspace (read with workspace_read): the harness contracts the game must implement, start at contracts/README.md. Read-only copies: implement them, never rewrite them in the game repo.",
        }),
      };
    } catch (e) {
      return { content: clip(errText(e), 2000), is_error: true };
    }
  },
};

const gameRead: ToolImpl = {
  description: "Read a file, or list a directory, inside your game clone. Paths are relative to the clone root. Call game_clone first.",
  input: z.object({ path: z.string().default(".") }).strict(),
  async run({ path: rel }, ctx) {
    try {
      const p = resolveInWorkspace(path.join(ctx.workspace, "game"), rel);
      const st = await stat(p);
      if (st.isDirectory()) {
        const entries = await readdir(p, { withFileTypes: true });
        return { content: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)" };
      }
      return { content: clip(await readFile(p, "utf8")) };
    } catch (e) {
      return { content: errText(e), is_error: true };
    }
  },
};

const gameWrite: ToolImpl = {
  description: "Write a text file inside your game clone (creates folders, overwrites). Call game_clone first. Commit with game_exec git.",
  input: z.object({ path: z.string().min(1), content: z.string().max(1_000_000) }).strict(),
  async run({ path: rel, content }, ctx) {
    try {
      const root = path.join(ctx.workspace, "game");
      const p = resolveInWorkspace(root, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
      return { content: `wrote ${path.relative(root, p)} (${content.length} chars)` };
    } catch (e) {
      return { content: errText(e), is_error: true };
    }
  },
};

const gameExec: ToolImpl = {
  description:
    "Run a command inside your game clone (git, build.sh targets, engine CLI, tests). No shell: give the command as a list, e.g. [\"git\",\"status\"]. " +
    "Exit code, stdout, and stderr come back; a non-zero exit is an error result you must fix, not retry unchanged.",
  input: z
    .object({
      command: z.array(z.string().min(1)).min(1).max(12).describe("Argv, e.g. [\"git\", \"log\", \"--oneline\", \"-5\"]"),
      timeout_s: z.number().int().min(1).max(600).optional().describe("Default 120; builds may need 600"),
    })
    .strict(),
  async run({ command, timeout_s }, ctx) {
    try {
      const cwd = path.join(ctx.workspace, "game");
      if (!existsSync(cwd)) throw new Error("no clone yet; call game_clone first");
      const [cmd, ...args] = command;
      const { promise, resolve } = Promise.withResolvers<{ out: string; err: string; code: number }>();
      // ANYCO_AGENT lets the game repo's pre-receive hook enforce the single-merger rule (tools/gamerepo/new-game.ts).
      const env = { ...process.env, ANYCO_AGENT: ctx.agent ?? "unknown" };
      // Own process group + our own timeout: execFile's timeout only SIGTERMs the direct child, so a build.sh that
      // started Godot (or a Godot that ignores SIGTERM) left orphans running for hours. Kill the whole group instead.
      const limitMs = (timeout_s ?? 120) * 1000;
      const MAX_OUT = 32 * 1024 * 1024;
      let timedOut = false;
      let settled = false;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const reaper = child.pid ? trackGroup(child.pid) : null; // runner exit/signal/kill -9 reaps the group too
      const take = (sink: Buffer[]) => (b: Buffer) => { if (outBytes < MAX_OUT) { sink.push(b); outBytes += b.length; } };
      child.stdout?.on("data", take(out));
      child.stderr?.on("data", take(err));
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8"), code });
      };
      child.on("error", (e) => { err.push(Buffer.from(String(e.message))); finish(127); });
      child.on("close", (code, signal) => finish(typeof code === "number" ? code : signal ? 128 : 1));
      const killGroup = (sig: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, sig); } catch { /* group already gone */ }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 2000).unref();
        // a grandchild holding the pipes open must not hold the agent: give up waiting 3 s after the kill
        setTimeout(() => finish(124), 3000).unref();
      }, limitMs);
      const r = await promise;
      killGroup("SIGKILL"); // nothing from this call outlives it (background children of a finished command included)
      reaper?.untrack();
      if (timedOut) r.err = `${r.err}\n(timed out after ${limitMs / 1000} s; the command and its children were killed)`;
      return {
        content: clip(`exit ${timedOut ? "timeout" : r.code}\n${r.out}${r.err ? `\nstderr:\n${r.err}` : ""}`),
        is_error: timedOut || r.code !== 0,
      };
    } catch (e) {
      return { content: errText(e), is_error: true };
    }
  },
};

const gameRepoTools: Record<string, ToolImpl> = {
  game_clone: gameClone,
  game_read: gameRead,
  game_write: gameWrite,
  game_exec: gameExec,
};

// ---------- art_tools (tools/art): deterministic post-processing + asset gate ----------
// All file paths are workspace-relative (the game clone lives at <workspace>/game), so the
// same path-safety rule as workspace_write applies. No default palette: the Art Director's
// style bible names one; callers pass it in.

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb");

async function artReadPng(workspace: string, rel: string): Promise<RgbaImage> {
  return decodePng(new Uint8Array(await readFile(resolveInWorkspace(workspace, rel))));
}

async function artWritePng(workspace: string, rel: string, img: RgbaImage) {
  await mkdir(path.dirname(resolveInWorkspace(workspace, rel)), { recursive: true });
  await writeFile(resolveInWorkspace(workspace, rel), encodePng(img));
}

const artTools: Record<string, ToolImpl> = {
  art_lock: {
    description:
      "Lock an image to a palette: binarize alpha at a threshold and snap every opaque pixel to the nearest " +
      "palette color by OKLab distance (ties → earlier entry). Pass the style bible's palette; there is no default.",
    input: z
      .object({
        path: z.string().min(1).describe("workspace-relative input PNG"),
        out: z.string().min(1).describe("workspace-relative output PNG"),
        palette: z.array(hexColor).min(1).max(64).describe('palette hexes from the style bible, e.g. ["#rrggbb", "#rrggbb"]'),
        alpha_threshold: z.number().int().min(0).max(255).optional().describe("alpha ≥ threshold → opaque (default 128)"),
      })
      .strict(),
    async run({ path: rel, out, palette, alpha_threshold }, ctx) {
      try {
        const img = await artReadPng(ctx.workspace, rel);
        const { image, stats } = lockPalette(img, palette, { alphaThreshold: alpha_threshold });
        await artWritePng(ctx.workspace, out, image);
        return { content: JSON.stringify({ out, width: image.width, height: image.height, ...stats }) };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
  art_snap: {
    description:
      "Downscale an upscaled render to exactly w×h by majority vote per cell (ties → lexicographically smallest RGBA). " +
      "Reports the detected scale and whether it was an integer.",
    input: z
      .object({
        path: z.string().min(1),
        out: z.string().min(1),
        w: z.number().int().positive().describe("target width in cells"),
        h: z.number().int().positive().describe("target height in cells"),
      })
      .strict(),
    async run({ path: rel, out, w, h }, ctx) {
      try {
        const img = await artReadPng(ctx.workspace, rel);
        const r = snapToGrid(img, { w, h });
        await artWritePng(ctx.workspace, out, r.image);
        const { scaleX, scaleY, uniform, integerScale } = r;
        return { content: JSON.stringify({ out, scaleX, scaleY, uniform, integerScale }) };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
  art_outline: {
    description: "Add a 1 px outer outline: transparent pixels 4-adjacent to opaque ones get the given color.",
    input: z.object({ path: z.string().min(1), out: z.string().min(1), color: hexColor }).strict(),
    async run({ path: rel, out, color }, ctx) {
      try {
        await artWritePng(ctx.workspace, out, addOutline(await artReadPng(ctx.workspace, rel), color));
        return { content: JSON.stringify({ out }) };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
  art_strip: {
    description: "Split a horizontal frame strip PNG into numbered frame-0.png, frame-1.png, … files.",
    input: z
      .object({
        path: z.string().min(1),
        out_dir: z.string().min(1).describe("workspace-relative directory for the frame files"),
        frames: z.number().int().positive().max(64),
      })
      .strict(),
    async run({ path: rel, out_dir, frames }, ctx) {
      try {
        const parts = splitStrip(await artReadPng(ctx.workspace, rel), frames);
        for (let i = 0; i < parts.length; i++) await artWritePng(ctx.workspace, `${out_dir}/frame-${i}.png`, parts[i]);
        return { content: JSON.stringify({ out_dir, frames: parts.length, frameWidth: parts[0].width, frameHeight: parts[0].height }) };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
  art_sheet: {
    description:
      "Contact sheet of PNGs side by side at an integer scale (no text). Writes the sheet and returns the cell rectangles → " +
      "frame-index mapping; the anchor frame goes first.",
    input: z
      .object({
        out: z.string().min(1).describe("workspace-relative output PNG"),
        paths: z.array(z.string().min(1)).min(1).describe("workspace-relative input PNGs, in frame order"),
        anchor: z.number().int().nonnegative().optional().describe("index of the anchor frame (default 0)"),
        scale: z.number().int().positive().optional().describe("integer upscale (default 1)"),
        gap: z.number().int().nonnegative().optional().describe("transparent pixels between cells (default 0)"),
      })
      .strict(),
    async run({ out, paths, anchor, scale, gap }, ctx) {
      try {
        const imgs = await Promise.all(paths.map((rel: string) => artReadPng(ctx.workspace, rel)));
        const { image, cells } = contactSheet(imgs, { anchor, scale, gap });
        await artWritePng(ctx.workspace, out, image);
        return { content: JSON.stringify({ out, cells }) };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
  art_gate: {
    description:
      "Run the asset gate on a game repo (default: your game clone at game/): manifest schema, palette lock, sizes, " +
      "frame layout, anchors, file coverage, and drift numbers. Returns the JSON report; ok=false lists every failure.",
    input: z.object({ repo: z.string().min(1).optional().describe("workspace-relative repo dir (default: game)") }).strict(),
    async run({ repo }, ctx) {
      try {
        const report = runGate(resolveInWorkspace(ctx.workspace, repo ?? "game"));
        return { content: JSON.stringify(report), is_error: !report.ok };
      } catch (e) {
        return { content: errText(e), is_error: true };
      }
    },
  },
};

// ---------- board (runner/board): the studio work board ----------
// Mirrors the hosted board tools board_read / board_write (docs/team/board.md); the local
// capability is four named tools over the same Board interface both backends implement.

/** Local agent spec names = folder names under agents/ (the loader enforces spec.name === folder). */
function agentNames(ctx: ToolContext): Set<string> {
  return new Set(
    readdirSync(ctx.agentsDir ?? AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}

const boardTools: Record<string, ToolImpl> = {
  board_create: {
    description:
      "Create a work card on the studio board — this is how work is assigned. The dispatcher starts the " +
      "assignee's local run once the card has no open blocker and the assignee is idle. Use blocked_by with " +
      "card ids to order work. Creating with the same key twice returns the existing card (no duplicate).",
    input: z
      .object({
        title: z.string().min(3).max(120).describe("What needs doing, as an instruction"),
        body: z.string().max(4000).optional().describe("The brief: what done looks like, constraints, context the assignee needs"),
        assignee: z.string().min(2).max(41).describe("Agent spec name that should do the work (a folder under agents/)"),
        blocked_by: z.array(z.string().max(64)).max(10).optional().describe("Card ids this card waits on"),
        key: z.string().max(128).optional().describe("Idempotency key: re-creating with the same key returns the existing card"),
      })
      .strict(),
    async run(i, ctx) {
      if (!ctx.board) return { content: "no board configured for this run (STUDIO_BOARD / dispatcher)", is_error: true };
      const names = agentNames(ctx);
      if (i.assignee === "studio-head") {
        return { content: "studio-head runs on its own cadence and from the window chat; it cannot be assigned a board card", is_error: true };
      }
      if (!names.has(i.assignee)) {
        return { content: `unknown assignee "${i.assignee}"; known agents: ${[...names].sort().join(", ")}`, is_error: true };
      }
      if (i.blocked_by?.length) {
        const cards = await ctx.board.list();
        const ids = new Set(cards.map((c) => c.id));
        const missing = i.blocked_by.filter((id: string) => !ids.has(id));
        if (missing.length) return { content: `unknown card id(s) in blocked_by: ${missing.join(", ")}`, is_error: true };
      }
      try {
        const { card, created } = await ctx.board.create({ title: i.title, body: i.body, assignee: i.assignee, blocked_by: i.blocked_by, key: i.key });
        return { content: JSON.stringify({ ...card, created }) };
      } catch (e) {
        return { content: `board_create refused: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  },
  board_list: {
    description:
      "List the studio board's cards (id, title, status, assignee, blockers — not bodies, by design; use " +
      "board_get for one card in full). Filter by status.",
    input: z.object({ status: z.enum(["todo", "doing", "blocked", "done"]).optional() }).strict(),
    async run(i, ctx) {
      if (!ctx.board) return { content: "no board configured for this run", is_error: true };
      const cards = (await ctx.board.list()).filter((c) => !i.status || c.status === i.status);
      const brief = cards.map(({ id, title, status, assignee, blocked_by, updated_at }) => ({ id, title, status, assignee, blocked_by, updated_at }));
      return { content: JSON.stringify({ count: brief.length, cards: brief }) };
    },
  },
  board_get: {
    description: "Read one card in full: the brief, the holder's note, and its comments.",
    input: z.object({ card_id: z.string().min(3).max(64) }).strict(),
    async run(i, ctx) {
      if (!ctx.board) return { content: "no board configured for this run", is_error: true };
      try {
        const [card, comments] = await Promise.all([ctx.board.get(i.card_id), ctx.board.comments(i.card_id)]);
        return { content: JSON.stringify({ ...card, comments }) };
      } catch (e) {
        return { content: `board_get refused: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  },
  board_comment: {
    description: "Add a comment to a card: progress, questions, or context for the next reader.",
    input: z.object({ card_id: z.string().min(3).max(64), body: z.string().min(1).max(4000) }).strict(),
    async run(i, ctx) {
      if (!ctx.board) return { content: "no board configured for this run", is_error: true };
      try {
        const c = await ctx.board.comment(i.card_id, i.body, ctx.agent ?? "unknown");
        return { content: JSON.stringify(c) };
      } catch (e) {
        return { content: `board_comment refused: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  },
};

// ---------- art_generate (tools/art): paid generation, budget-capped like inference ----------

/** Chain the deterministic pipeline over generated PNGs using the game manifest's locked grid/palette. */
async function applyArtPostprocess(
  workspace: string,
  opts: { snap?: boolean; lock?: boolean; outline?: string },
  images: string[],
): Promise<Record<string, unknown>> {
  const manifestFile = resolveInWorkspace(workspace, path.join("game", "assets", "manifest.json"));
  let manifest: { grid?: { w: number; h: number }; palette?: string[]; assets?: Array<{ path?: string; size?: { w: number; h: number }; frames?: number }> };
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (e) {
    throw new Error(`postprocess needs the game manifest at game/assets/manifest.json (game_clone first): ${errText(e)}`);
  }
  if (!manifest.grid || !Array.isArray(manifest.palette) || manifest.palette.length === 0)
    throw new Error("postprocess needs grid and palette locked in game/assets/manifest.json (the Art Director locks them)");

  const steps: Record<string, unknown> = {};
  let lockChanged = 0;
  let lockMaxDistance = 0;
  let lastSnap: { scaleX: number; scaleY: number; uniform: boolean; integerScale: boolean } | null = null;
  for (const rel of images) {
    let img = decodePng(new Uint8Array(await readFile(resolveInWorkspace(workspace, rel))));
    if (opts.snap) {
      // Snap to the whole asset (size is ONE frame × frames), never to a single grid cell.
      const repoRel = rel.replace(/^game\//, "");
      const entry = manifest.assets?.find((a) => a.path === repoRel);
      if (!entry?.size)
        throw new Error(`snap needs the manifest entry for "${repoRel}" with its size (one frame) declared first`);
      if (entry.size.w % manifest.grid.w !== 0 || entry.size.h % manifest.grid.h !== 0)
        throw new Error(`manifest size ${entry.size.w}x${entry.size.h} for "${repoRel}" is not a multiple of grid ${manifest.grid.w}x${manifest.grid.h}`);
      const target = { w: entry.size.w * (entry.frames ?? 1), h: entry.size.h };
      if (img.width < target.w || img.height < target.h)
        throw new Error(`generated ${img.width}x${img.height} is smaller than the asset ${target.w}x${target.h}; generate at least the target size`);
      const r = snapToGrid(img, target);
      lastSnap = { scaleX: r.scaleX, scaleY: r.scaleY, uniform: r.uniform, integerScale: r.integerScale };
      img = r.image;
    }
    if (opts.lock) {
      const r = lockPalette(img, manifest.palette);
      lockChanged += r.stats.pixelsChanged;
      lockMaxDistance = Math.max(lockMaxDistance, r.stats.maxDistance);
      img = r.image;
    }
    if (opts.outline) img = addOutline(img, opts.outline);
    await artWritePng(workspace, rel, img);
  }
  if (opts.snap && lastSnap) steps.snap = lastSnap;
  if (opts.lock) steps.lock = { pixelsChanged: lockChanged, maxDistance: lockMaxDistance };
  if (opts.outline) steps.outline = { color: opts.outline };
  return steps;
}

const providerEnum = z.enum(["pixellab", "retrodiffusion", "comfy"]);

/** Log a reported balance; write ONE ledger note per low threshold per provider per day. */
function noteCredits(
  ctx: ToolContext, provider: ProviderName, bal: Balance | null, source: string, generationsUsed: number | null = null,
): { provider: ProviderName; remaining: number | null; unit: Balance["unit"] | null; total: number | null; generations_used: number | null; low_notes: string[] } {
  if (bal === null || !Number.isFinite(bal.remaining)) return { provider, remaining: null, unit: null, total: null, generations_used: generationsUsed, low_notes: [] };
  const paths = statePaths(ctx.runsDir);
  const ledgerFile = ctx.ledgerFile ?? LEDGER_FILE;
  const noted = (ref: string) => ledgerRead(ledgerFile).some((e) => e.kind === "decision" && e.topic === "art.credits_low" && (e.refs ?? []).includes(ref));
  const line = { ts: new Date().toISOString(), provider, remaining: bal.remaining, unit: bal.unit, total: bal.total, generations_used: generationsUsed, run_id: ctx.run_id ?? "unknown", source };
  const notes = recordCredit(paths.credits, line, noted);
  const what = bal.unit === "generations" ? `${bal.remaining} generations left${bal.total !== null ? ` of ${bal.total}` : ""}` : `${bal.remaining} USD left`;
  for (const n of notes)
    ledgerAppend({
      kind: "decision", ts: new Date().toISOString(), agent: ctx.agent ?? "art_generate", run_id: ctx.run_id ?? "unknown", topic: "art.credits_low",
      decision: n.threshold === "zero"
        ? `${provider} is out (${what}): generation moves to the other provider or the procedural floor`
        : n.threshold === "low400"
          ? `${provider} is low: ${what} (at or under ${LOW_GENERATIONS})`
          : `${provider} credits are low: ${what}, under ${LOW_PCT}% of today's first reading ${n.first_today}`,
      rationale: "Credits are not topped up by the harness (no purchases). Conserve: anchors only for bake-offs, quote batches, cap regenerations and candidates.",
      refs: [n.ref, statePaths(ctx.runsDir).credits],
    }, ledgerFile);
  return { provider, remaining: bal.remaining, unit: bal.unit, total: bal.total, generations_used: generationsUsed, low_notes: notes.map((n) => n.threshold) };
}
const LOW_PCT = 20;

/** ONE ledger decision per day when the PixelLab floor stops a call (deduplicated by its refs key, like the low notes). */
function noteFloor(ctx: ToolContext, v: FloorVerdict): void {
  const ledgerFile = ctx.ledgerFile ?? LEDGER_FILE;
  const ref = `pixellab-floor:${new Date().toISOString().slice(0, 10)}`;
  if (ledgerRead(ledgerFile).some((e) => e.kind === "decision" && e.topic === "spend.pixellab_floor" && (e.refs ?? []).includes(ref))) return;
  ledgerAppend({
    kind: "decision", ts: new Date().toISOString(), agent: ctx.agent ?? "art_generate", run_id: ctx.run_id ?? "unknown", topic: "spend.pixellab_floor",
    decision: `PixelLab floor stops pixellab generation: remaining ${v.remaining ?? "unreadable"}, floor ${v.floor} (PIXELLAB_MIN_REMAINING), call estimate ${v.estimate}`,
    rationale: "PixelLab is one generations balance shared across studios; the floor keeps a reserve. Calls go to comfy or the procedural floor until the balance is above floor + estimate.",
    refs: [ref],
  }, ledgerFile);
}

/**
 * Collect a PixelLab background job that an earlier call submitted (and was billed for) but stopped
 * waiting on: poll it, write the result exactly like a fresh call. No submit, no new generation, no
 * charge, no regeneration count, no justify; postprocess applies as usual.
 */
async function collectJob(i: any, ctx: ToolContext): Promise<ToolOutput> {
  const provider = i.provider ?? "pixellab";
  if (provider !== "pixellab") return { content: "resume_job_id collects PixelLab background jobs only", is_error: true };
  const { justify: _j, postprocess: _p, max_candidates, resume_job_id, ...gen } = i;
  let result: GenerateResult;
  try {
    result = await generate({ ...gen, provider, maxCandidates: max_candidates, resumeJobId: resume_job_id }, { workspace: ctx.workspace });
  } catch (e) {
    return { content: errText(e), is_error: true, cost_micro_usd: 0 };
  }
  try {
    let postprocess: Record<string, unknown> | null = null;
    if (i.postprocess && (i.postprocess.snap || i.postprocess.lock || i.postprocess.outline))
      postprocess = await applyArtPostprocess(ctx.workspace, i.postprocess, result.images);
    return { content: JSON.stringify({ ...result, postprocess, collected: resume_job_id, generation: "not counted (collected an earlier job)" }), cost_micro_usd: 0 };
  } catch (e) {
    return { content: `collected ${result.images.join(", ")} but postprocess failed: ${errText(e)}`, is_error: true, cost_micro_usd: 0 };
  }
}

const artGenerate: ToolImpl = {
  description:
    "Generate pixel art with a paid provider (PixelLab or Retro Diffusion) and write PNGs into the workspace. " +
    "Animation: pass frames. On pixellab it animates a REFERENCE still (required: the start frame, width/height = its size) " +
    "with prompt as the action ('walking', 'idle breathing') via animate-with-text-v3, and writes ONE horizontal strip (frames × width, 1 row). " +
    "Every call reports cost_micro_usd and is charged to the run budget — no raw generations land unprocessed when " +
    "postprocess is set: snap downscales to the manifest grid, lock forces the manifest palette, outline takes the " +
    "style bible's outline color. The manifest must be locked (game_clone) before postprocess can run. " +
    `Credits are free-trial and never topped up: omit provider to use the reference anchor's winning provider; an exhausted provider falls back to the other once; with both gone the result is {exhausted:"all", fallback:"procedural"} at no cost. ` +
    `Each asset gets one generation plus ${MAX_REGENERATIONS} regenerations. Animation (frames or rd_animation/rd_advanced_animation styles) needs justify. Quote batches with art_quote first. ` +
    "A PixelLab job that timed out or lost its poll keeps running and is billed: the error names its job_id; never regenerate, call again with the same inputs plus resume_job_id to collect it for free. " +
    `max_candidates (default ${DEFAULT_CANDIDATES}, max ${MAX_CANDIDATES}) caps the images kept per call to keep the gallery reviewable; it does not save generations. ` +
    "PixelLab results report generations_used (subscription balance before vs after). " +
    "With PIXELLAB_MIN_REMAINING set, pixellab is refused (no request) at or below that floor, or when this call's estimate would cross it; the call moves to comfy " +
    "or the procedural floor and the result's pixellab_floor says so: then use provider comfy with your reference image, or stop and report. " +
    "provider comfy = the local lab ComfyUI (frozen IP-Adapter recipe on `reference`, seed = identity, default 42): free (cost 0, cost_source local), stills only, " +
    "always 768x768 with an opaque background, so pass postprocess (snap/lock/outline) to reach the manifest size and palette. Use it when the task or the anchor " +
    "winner names comfy; when the lab is down the call falls back to pixellab once and comfy is tried again next call.",
  input: z
    .object({
      provider: providerEnum.optional().describe("omit to use the anchor-winning provider of `reference` (art_anchor_winner); comfy = the local lab (free, stills, 768x768)"),
      prompt: z.string().min(1).max(2000),
      width: z.number().int().min(12).max(792),
      height: z.number().int().min(12).max(792),
      out: z.string().min(1).regex(/\.png$/i, "out must end in .png").describe("workspace-relative output PNG"),
      reference: z.string().min(1).optional().describe("workspace-relative reference/anchor PNG"),
      seed: z.number().int().nonnegative().optional(),
      frames: z.number().int().optional().describe("animation frames. retrodiffusion: frames_duration 4|6|8|10|12|16. pixellab: 4-16 even (4|6|8|10|12|14|16); animates `reference` (required, the start frame, at most 256x256, width/height = its size) with `prompt` as the action; w*h*frames <= 524288. Output: one horizontal strip (frames x width, 1 row)"),
      transparent: z.boolean().optional().describe("transparent background (default true)"),
      style: z.string().max(120).optional().describe("Retro Diffusion prompt_style id"),
      negative: z.string().max(2000).optional().describe("comfy only: negative prompt (default empty)"),
      max_candidates: z.number().int().min(1).max(MAX_CANDIDATES).default(DEFAULT_CANDIDATES).describe(`keep at most this many returned images (default ${DEFAULT_CANDIDATES}); extras are discarded unwritten. Keeps the gallery reviewable; it does NOT save generations (the provider bills what it made)`),
      justify: z.string().min(10).max(300).optional().describe("required for animation: why the cheaper ladder steps (cutout parts, in-engine motion) won't do"),
      resume_job_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("PixelLab only: after a timeout or poll failure, the error names a job_id. Call again with the SAME inputs plus resume_job_id to collect that job: no new generation, no charge, no regeneration count"),
      postprocess: z
        .object({
          snap: z.boolean().optional().describe("downscale to the manifest entry's full size (size × frames) by majority vote"),
          lock: z.boolean().optional().describe("force the manifest palette (OKLab nearest)"),
          outline: hexColor.optional().describe("outline color from the style bible; omit to skip outlining"),
        })
        .strict()
        .optional(),
    })
    .strict(),
  async run(i, ctx) {
    if (i.resume_job_id) return collectJob(i, ctx);
    const paths = statePaths(ctx.runsDir);
    const done = generationCount(paths.gallery, i.out);
    if (done >= 1 + MAX_REGENERATIONS)
      return { content: `refused: ${i.out} has had ${done} paid generations (1 + ${MAX_REGENERATIONS} regenerations is the cap). Fix the prompt/reference or cut to the fallback ladder.`, is_error: true };
    if (isAnimation(i) && !i.justify)
      return { content: "refused: animation endpoints (frames, rd_animation__*, rd_advanced_animation__*) are the expensive ones; pass justify with why cutout parts or in-engine motion won't do", is_error: true };
    const winner = i.reference ? anchorWinner(paths.gallery, i.reference) : undefined;
    let requested: ProviderName | undefined = i.provider;
    if (!requested) {
      if (!winner) return { content: `provider is required: no anchor winner is recorded${i.reference ? ` for ${i.reference}` : " (no reference given)"}. Bake-offs are for anchors; record the winner with art_anchor_winner.`, is_error: true };
      requested = winner;
    } else if (winner && requested !== winner && !isExhausted(paths.providers, winner)) {
      return { content: `refused: ${i.reference}'s anchor bake-off was won by ${winner}; batch generation uses it (omit provider). Only anchors are generated on both.`, is_error: true };
    }

    const exhausted: ProviderName[] = [];
    const unavailable: ProviderName[] = []; // transient (comfy down): skipped this call only, never persisted
    const notes: string[] = [];
    let result: GenerateResult | null = null;
    let credits: ReturnType<typeof noteCredits> | null = null;
    let before: Balance | null = null;
    let floored: FloorVerdict | null = null; // T35: the PixelLab floor stopped pixellab for this call (never persisted)
    let floor: number | null;
    try {
      floor = pixellabFloor();
    } catch (e) {
      return { content: errText(e), is_error: true };
    }
    const chain: ProviderName[] = [requested, other(requested)];
    for (let k = 0; k < chain.length; k++) {
      const p = chain[k];
      if (isExhausted(paths.providers, p)) {
        exhausted.push(p);
        continue;
      }
      if (p === "pixellab" && floor !== null) {
        // the live balance before EVERY pixellab call (free GET /v2/balance), never a cached one
        before = await providerBalance("pixellab", {}).catch(() => null);
        const v = checkPixellabFloor(before, floor, pixellabCallEstimate(paths.credits));
        if (v.blocked) {
          floored = v;
          notes.push(v.message);
          noteFloor(ctx, v);
          // like an exhausted provider for this call only: no request; comfy next (stills), then the rest of the chain
          if (i.frames === undefined && !chain.includes("comfy")) chain.splice(k + 1, 0, "comfy");
          else if (i.frames !== undefined) notes.push("comfy makes stills only, so there is no comfy fallback for an animation");
          continue;
        }
      }
      if (p !== requested && i.frames !== undefined && p === "pixellab" && !i.reference) {
        notes.push("pixellab animates only from a reference still, and none was given, so there is no animation fallback");
        continue;
      }
      if (p !== requested) {
        const why = floored && requested === "pixellab" ? "at its floor" : unavailable.includes(requested) ? "unavailable" : "exhausted";
        notes.push(`${requested} is ${why}; tried ${p} once instead (same prompt and size)`);
      }
      try {
        const { justify: _j, postprocess: _p, max_candidates, ...gen } = i;
        // PixelLab: read the (free) balance before and after, so the result says what the call used (already read when a floor is set)
        if (p === "pixellab" && floor === null) before = await providerBalance("pixellab", {}).catch(() => null);
        else if (p !== "pixellab") before = null;
        result = await generate({ ...gen, provider: p, maxCandidates: max_candidates }, { workspace: ctx.workspace });
        break;
      } catch (e) {
        if (e instanceof ProviderExhausted) {
          markExhausted(paths.providers, p, { remaining_balance: e.remaining_balance, reason: e.message });
          noteCredits(ctx, p, { remaining: e.remaining_balance ?? 0, unit: p === "pixellab" && before?.unit === "generations" ? "generations" : "usd", total: before?.total ?? null }, "exhausted");
          exhausted.push(p);
          continue;
        }
        if (e instanceof ProviderUnavailable) {
          notes.push(e.message);
          unavailable.push(p);
          continue;
        }
        if (e instanceof ChargedFailure) {
          countGeneration(paths.gallery, i.out); // it billed
          return { content: errText(e), is_error: true, cost_micro_usd: e.cost_micro_usd };
        }
        return { content: errText(e), is_error: true };
      }
    }
    if (!result) {
      const all = PROVIDERS.every((p) => exhausted.includes(p) || (p === "pixellab" && floored !== null));
      return {
        content: JSON.stringify({
          exhausted: all ? "all" : exhausted, ...(unavailable.length ? { unavailable } : {}), ...(floored ? { pixellab_floor: floored } : {}), fallback: "procedural", cost_micro_usd: 0, notes,
          next: floored
            ? `${floored.message}. Otherwise take the fallback ladder's floor: simple shapes animated in engine (bob, flash, squash-and-stretch, particles); log it with log_decision (topic art.provider_fallback).`
            : "Take the fallback ladder's floor: simple shapes animated in engine (bob, flash, squash-and-stretch, particles). Log it with log_decision (topic art.provider_fallback). This is a guaranteed outcome, not a failure.",
        }),
        cost_micro_usd: 0,
      };
    }
    const generation = countGeneration(paths.gallery, i.out);
    // comfy is local: no balance read and no credits line
    const after: Balance | null = result.provider === "comfy"
      ? null
      : typeof result.metadata.remaining_balance === "number"
        ? { remaining: result.metadata.remaining_balance as number, unit: "usd", total: null }
        : await providerBalance(result.provider, {}).catch(() => null);
    // generations used: the balance delta (T21); else the job's own usage when it reports generations
    const usage = result.metadata.usage as { type?: string; generations?: number } | null | undefined;
    const used = before && after && before.unit === "generations" && after.unit === "generations"
      ? Math.round((before.remaining - after.remaining) * 1000) / 1000
      : usage?.type === "generations" && typeof usage.generations === "number" ? usage.generations : null;
    credits = noteCredits(ctx, result.provider, after, "generation", used);
    const extra = { generation: `${generation} of ${1 + MAX_REGENERATIONS}`, credits, ...(used !== null ? { generations_used: used } : {}), ...(result.provider !== requested ? { fallback_from: requested } : {}), ...(floored ? { pixellab_floor: floored } : {}), ...(notes.length ? { notes } : {}) };
    try {
      let postprocess: Record<string, unknown> | null = null;
      if (i.postprocess && (i.postprocess.snap || i.postprocess.lock || i.postprocess.outline))
        postprocess = await applyArtPostprocess(ctx.workspace, i.postprocess, result.images);
      return { content: JSON.stringify({ ...result, postprocess, ...extra }), cost_micro_usd: result.cost_micro_usd };
    } catch (e) {
      // generation succeeded and was paid; postprocess failing must not erase the charge
      return { content: `generated ${result.images.join(", ")} but postprocess failed: ${errText(e)} ${JSON.stringify(extra)}`, is_error: true, cost_micro_usd: result.cost_micro_usd };
    }
  },
};

const artQuote: ToolImpl = {
  description:
    "Free cost check before a batch: Retro Diffusion's check_cost dry run (generates and charges nothing) or PixelLab's price table, " +
    "times count, with the remaining balance. Run it before any batch of art_generate calls.",
  input: z
    .object({
      provider: providerEnum,
      prompt: z.string().min(1).max(2000),
      width: z.number().int().min(12).max(792),
      height: z.number().int().min(12).max(792),
      count: z.number().int().min(1).max(200).describe("how many calls the batch will make"),
      reference: z.string().min(1).optional(),
      frames: z.number().int().optional(),
      style: z.string().max(120).optional(),
    })
    .strict(),
  async run({ count, ...i }, ctx) {
    const paths = statePaths(ctx.runsDir);
    if (isExhausted(paths.providers, i.provider)) return { content: JSON.stringify({ provider: i.provider, exhausted: true, per_call_usd: null, total_usd: null }) };
    try {
      const q = await providerQuote({ ...i, out: "quote.png" }, { workspace: ctx.workspace });
      const credits = noteCredits(ctx, q.provider, q.remaining_balance === null ? null : { remaining: q.remaining_balance, unit: q.unit, total: q.total ?? null }, "quote");
      const total = Math.round(q.per_call_usd * count * 1e6) / 1e6;
      return { content: JSON.stringify({ ...q, count, total_usd: total, affordable: q.remaining_balance === null || q.unit !== "usd" ? null : q.remaining_balance >= total, credits }) };
    } catch (e) {
      if (e instanceof ProviderExhausted) {
        markExhausted(paths.providers, i.provider, { remaining_balance: e.remaining_balance, reason: e.message });
        noteCredits(ctx, i.provider, { remaining: e.remaining_balance ?? 0, unit: "usd", total: null }, "exhausted");
      }
      return { content: errText(e), is_error: true };
    }
  },
};

const artAnchorWinner: ToolImpl = {
  description: "Record which provider won an anchor's bake-off. art_generate then defaults to it for every asset that references that anchor.",
  input: z.object({ anchor: z.string().min(1).describe("workspace-relative anchor PNG, as you pass it to reference"), provider: providerEnum, why: z.string().min(3).max(300) }).strict(),
  async run({ anchor, provider, why }, ctx) {
    recordAnchorWinner(statePaths(ctx.runsDir).gallery, anchor, provider, ctx.run_id ?? "unknown", why);
    return { content: JSON.stringify({ anchor, provider, recorded: true }) };
  },
};

const artProviders: ToolImpl = {
  description: "Read-only: which providers are exhausted, the latest reported balance of each, anchor winners, and per-asset generation counts.",
  input: z.object({}).strict(),
  async run(_i, ctx) {
    const paths = statePaths(ctx.runsDir);
    const credits = readCredits(paths.credits);
    const latest = Object.fromEntries(PROVIDERS.map((p) => [p, credits.filter((c) => c.provider === p).at(-1) ?? null]));
    const g = readGallery(paths.gallery);
    return { content: clip(JSON.stringify({ providers: readProviders(paths.providers), latest_balance: latest, anchors: g.anchors, generations: g.generations, max_regenerations: MAX_REGENERATIONS })) };
  },
};

// ---------- gallery (T18): never overwrite — art/gallery/<asset>/<n>-<provider>-<verdict>.png ----------
// The Art Director (or the runner helpers below) copies a candidate/sheet into the clone's gallery
// and indexes it; the asset gate ignores art/ (review material, not game assets) and exports never
// see it (it is not under assets/ and not inside dist/).

/** Next gallery path for an asset: lowest unused ordinal, so a write never clobbers an earlier one. */
export function nextGalleryPath(repoRoot: string, asset: string, provider: string, verdict: string): string {
  const n = nextGalleryOrdinal(repoRoot, asset);
  return `${GALLERY_DIR}/${asset}/${n}-${provider}-${verdict}.png`;
}

/** Copy one PNG into the clone's gallery and index it. Throws when the source is missing or not a PNG. */
export async function galleryRecord(
  clone: string,
  entry: { asset: string; source: string; provider: string; verdict: "accepted" | "rejected"; reason: string; gate?: Record<string, unknown> | null },
  runId: string,
): Promise<{ file: string; entry: unknown }> {
  const bytes = await readFile(path.join(clone, entry.source));
  if (bytes.length < 8 || bytes.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(`gallery source is not a PNG: ${entry.source}`);
  const file = nextGalleryPath(clone, entry.asset, entry.provider, entry.verdict);
  const abs = path.join(clone, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  const recorded = recordGalleryImage(clone, {
    asset: entry.asset,
    file,
    provider: entry.provider === "contact-sheet" ? "contact-sheet" : (entry.provider as "pixellab" | "retrodiffusion"),
    verdict: entry.verdict,
    reason: entry.reason,
    gate: entry.gate ?? null,
    run_id: runId,
  });
  return { file, entry: recorded };
}

// ---------- art_signoff (T18): the human checkpoint before any batch beyond the anchors ----------
// ask-gated by the spec (art-director only): the call blocks in the approvals queue (T1) until the
// operator approves or denies it. Approval → continue; denial → the note comes back as a normal
// result the model can act on (revise the anchors), not a dead end.

const artSignoff: ToolImpl = {
  description:
    "Ask the human operator to sign off on the anchor set before ANY batch generation beyond the anchors. " +
    "Pass the style bible path and the anchor contact sheet path (both inside your clone); the call blocks until the operator decides.",
  input: z
    .object({
      style_bible_path: z.string().min(3).max(200).describe("repo-relative style bible, e.g. docs/style-bible.md"),
      contact_sheet_path: z.string().min(3).max(200).describe("repo-relative anchor contact sheet PNG"),
    })
    .strict(),
  async run(i, ctx) {
    // Inputs are recorded in the approval request (the queue shows them to the operator); the body
    // only restates what was signed off, so the transcript carries the checkpoint too.
    return {
      content: JSON.stringify({
        signoff: "granted",
        style_bible: i.style_bible_path,
        contact_sheet: i.contact_sheet_path,
        next: "Continue the batch: generate non-anchor assets against the anchors.",
      }),
    };
  },
};

const deniedSignoff = (note: string) =>
  JSON.stringify({
    signoff: "denied",
    note,
    next: "Revise the anchors (regenerate, re-lock the manifest if the palette or grid changed), then ask again.",
  });

// ---------- itch_push / itch_status: butler sends (ask-gated by spec) ----------
// butler reads BUTLER_API_KEY from env itself, so the key is never in argv, results, or the ledger.

const ITCH_TARGET = /^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}:[a-z0-9][a-z0-9-]{0,19}$/;

/** Refuse symlinks anywhere inside the tree butler is about to upload. */
async function assertNoSymlinks(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`symlink "${entry.name}" inside the push dir is not allowed`);
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await assertNoSymlinks(p);
  }
}

/** Run butler; a missing binary is a named error, not an empty spawn failure. Butler gets a
 *  minimal env (it only needs PATH/HOME + its key) and its output is redacted: the key value
 *  never reaches the tool result, whatever butler prints. */
async function butler(args: string[], timeoutMs: number): Promise<{ out: string; err: string; code: number }> {
  const bin = process.env.BUTLER_BIN ?? "butler";
  const key = process.env.BUTLER_API_KEY ?? "";
  const redact = (s: string) => (key ? s.split(key).join("***") : s);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...(key ? { BUTLER_API_KEY: key } : {}) };
  const { promise, resolve } = Promise.withResolvers<{ out: string; err: string; code: number }>();
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env }, (error, stdout, stderr) => {
    // string code = spawn failure (ENOENT, ENOTDIR, EACCES...); a number is a real exit code
    if (error && typeof error.code !== "number") resolve({ out: "", err: redact(`butler failed to start (${bin}): ${error.message}; set BUTLER_BIN or install butler`), code: -1 });
    else resolve({ out: redact(String(stdout)), err: redact(String(stderr)), code: typeof error?.code === "number" ? error.code : 0 });
  });
  return promise;
}

const noKey = "BUTLER_API_KEY is not set; the operator provides it in env only";

const itchPush: ToolImpl = {
  description:
    "Push a build from your clone's dist/ to an itch.io channel with butler. Dry-run by default; a real push needs dry_run:false and the operator's approval. " +
    "dir must be a directory inside dist/, and build_id must match dist/build_id exactly.",
  input: z
    .object({
      dir: z.string().min(1).max(200).describe("Channel dir inside the clone's dist/, e.g. 'web' or 'windows'"),
      target: z.string().regex(ITCH_TARGET).describe("itch target '<user>/<game>:<channel>', lowercase, e.g. 'any-co/studio-game:html5'"),
      build_id: z.string().min(8).max(60).describe("Exactly the contents of dist/build_id"),
      dry_run: z.boolean().default(true).describe("Default true (no upload); false pushes for real, after operator approval"),
    })
    .strict(),
  dryRunField: "dry_run", // a dry run uploads nothing: no approval needed (T27)
  async run({ dir, target, build_id, dry_run = true }, ctx) {
    try {
      if (!process.env.BUTLER_API_KEY) throw new Error(noKey);
      const distRoot = path.join(ctx.workspace, "game", "dist");
      if (!existsSync(path.join(distRoot, "build_id"))) throw new Error("no dist/build_id in your clone; run build.sh first");
      const built = (await readFile(path.join(distRoot, "build_id"), "utf8")).trim();
      if (built !== build_id) throw new Error(`build_id mismatch: dist/build_id says "${built}", you passed "${build_id}"`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(built)) throw new Error(`dist/build_id "${built}" breaks the build_id contract (<yyyymmdd-hhmm>-<short-sha>); refusing to pass it to butler`);
      // Lexical checks are not enough (symlinks): pin both sides to real paths, require the
      // channel dir to sit strictly INSIDE dist/, and refuse any symlink in the pushed tree —
      // the agent controls dist/, and butler would happily upload wherever a link points.
      const distReal = realpathSync(distRoot);
      const dirReal = realpathSync(resolveInWorkspace(distRoot, dir));
      if (dirReal === distReal || !dirReal.startsWith(distReal + path.sep)) throw new Error(`"${dir}" must be a channel directory strictly inside dist/, not dist/ itself or a link out of it`);
      await assertNoSymlinks(dirReal);
      const r = await butler(["push", dirReal, target, `--userversion=${build_id}`, ...(dry_run ? ["--dry-run"] : [])], 600_000);
      return { content: clip(`exit ${r.code}${dry_run ? " (dry-run)" : " (REAL PUSH)"}\n${r.out}${r.err ? `\nstderr:\n${r.err}` : ""}`), is_error: r.code !== 0 };
    } catch (e) {
      return { content: errText(e), is_error: true };
    }
  },
};

const itchStatus: ToolImpl = {
  description: "Read-only: butler status of an itch channel (latest pushes per channel). No upload, not gated.",
  input: z.object({ target: z.string().regex(ITCH_TARGET).describe("itch target '<user>/<game>:<channel>'") }).strict(),
  async run({ target }) {
    if (!process.env.BUTLER_API_KEY) return { content: noKey, is_error: true };
    const r = await butler(["status", target], 120_000);
    return { content: clip(`exit ${r.code}\n${r.out}${r.err ? `\nstderr:\n${r.err}` : ""}`), is_error: r.code !== 0 };
  },
};

// ---------- email_send: outreach mail from the studio's Naïve identity inbox ----------
// SDK shape: emails.send(identityId, inboxId, { to: [addr], subject, text }). The studio address
// (identity + inbox ids) comes from env only; the blocklist refuses addresses or whole domains.

const blocklisted = (to: string, entries: string[]) => {
  const t = to.toLowerCase();
  const domain = t.split("@")[1] ?? "";
  return entries.some((b) => t === b || (domain !== "" && (domain === b.replace(/^@/, "") || domain.endsWith("." + b.replace(/^@/, "")))));
};

const emailSend: ToolImpl = {
  description:
    "Send one outreach email from the studio's own inbox. One recipient per call, plain text only. The operator approves every send; write the draft first, then send it.",
  input: z
    .object({
      to: z.string().regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/).describe("One recipient address, plain form only"),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10_000),
    })
    .strict(),
  async run({ to, subject, body }, ctx) {
    if (!ctx.naive) return { content: "email_send needs a Naïve client (NAIVE_API_KEY)", is_error: true };
    const identityId = process.env.NAIVE_EMAIL_IDENTITY_ID;
    const inboxId = process.env.NAIVE_EMAIL_INBOX_ID;
    if (!identityId || !inboxId)
      return { content: "email_send needs NAIVE_EMAIL_IDENTITY_ID and NAIVE_EMAIL_INBOX_ID in env (the studio identity + inbox to send from)", is_error: true };
    const entries = (process.env.STUDIO_EMAIL_BLOCKLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (blocklisted(to, entries)) return { content: `"${to}" is on the send blocklist (STUDIO_EMAIL_BLOCKLIST)`, is_error: true };
    try {
      const r = await ctx.naive.emails.send(identityId, inboxId, { to: [to], subject, text: body });
      if (!r.accepted) return { content: JSON.stringify({ ...r, note: "Naïve did not accept this send; do not report it as sent" }), is_error: true };
      return { content: JSON.stringify({ accepted: r.accepted, from: r.from, to: r.to, sent_at: r.sent_at }) };
    } catch (e) {
      const status = e instanceof Error && "status" in e ? `${String(e.status)} ` : "";
      return { content: clip(`email send failed: ${status}${errText(e)}`, 2000), is_error: true };
    }
  },
};

// ---------- site_deploy / site_status: the studio site as a Naïve App ----------
// SDK shape (docs/capabilities -> apps): apps.deploy(id, path -> base64 contents, content_hash?);
// builds run async (queued -> building -> ready on read), apps.redeploy(id, fromDeployment) ships an
// earlier deployment's kept files again (rollback, nothing uploaded). App id comes from env only.

const SITE_MAX_FILES = 500;
const SITE_MAX_BYTES = 2 * 1024 * 1024;

/** A deploy dir must really live strictly inside the clone: lexical checks miss a symlinked dir (dist/web -> /elsewhere),
 *  which readdir would follow and publish. Same rule as itch_push's dist confinement. */
function realDirInsideClone(clone: string, dirAbs: string, label: string): string {
  const cloneReal = realpathSync(clone);
  const real = realpathSync(dirAbs);
  if (real === cloneReal || !real.startsWith(cloneReal + path.sep))
    throw new Error(`"${label}" must be a directory strictly inside your clone (it resolves to ${real === cloneReal ? "the clone root" : "a path outside it"})`);
  return real;
}

/** Collect a directory into the deploy file map: key = prefix + relative path. Symlinks are refused, not followed. */
async function collectSiteFiles(abs: string, prefix: string, includeHidden: boolean, files: Map<string, Buffer>) {
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && !includeHidden) continue;
    if (entry.isSymbolicLink()) throw new Error(`${prefix}${entry.name} is a symlink; the site deploy publishes real files only`);
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) await collectSiteFiles(p, `${prefix}${entry.name}/`, includeHidden, files);
    else if (entry.isFile()) {
      if (files.size >= SITE_MAX_FILES) throw new Error(`site deploy tops out at ${SITE_MAX_FILES} files`);
      const buf = await readFile(p);
      if (buf.byteLength > SITE_MAX_BYTES) throw new Error(`${prefix}${entry.name} is ${Math.round(buf.byteLength / 1024)} KB; the per-file cap is ${SITE_MAX_BYTES / 1024} KB`);
      files.set(prefix + entry.name, buf);
    }
  }
}

const siteDeploy: ToolImpl = {
  description:
    "Publish the studio site to the studio's Naïve App: the web build (default dist/web) plus site/ if the marketing agents wrote one. " +
    "The operator approves every deploy; builds run async, so check site_status for ready. rollback_to ships an earlier deployment again (also approved).",
  input: z
    .object({
      dir: z.string().min(1).max(200).default("dist/web").describe("Web-root dir inside your clone (build.sh build-web output)"),
      site_dir: z.string().min(1).max(200).default("site").describe("Extra dir inside your clone published under site/ (landing page, devlog); skipped when absent"),
      include_hidden: z.boolean().default(false).describe("Ship dotfiles too (default: skipped)"),
      rollback_to: z.string().min(4).max(80).optional().describe("Deployment id to ship again instead of uploading files"),
    })
    .strict(),
  async run({ dir = "dist/web", site_dir = "site", include_hidden = false, rollback_to }, ctx) {
    if (!ctx.naive) return { content: "site_deploy needs a Naïve client (NAIVE_API_KEY)", is_error: true };
    const appId = process.env.STUDIO_SITE_APP_ID;
    if (!appId)
      return { content: "STUDIO_SITE_APP_ID is not set; the operator creates the studio app once (docs/naive-notes.md, Apps) and sets its id in env", is_error: true };
    try {
      if (rollback_to) {
        const d = await ctx.naive.apps.redeploy(appId, rollback_to);
        return { content: JSON.stringify({ deployment: d.id, status: d.status, url: d.url, rolled_back_to: rollback_to }) };
      }
      const clone = path.join(ctx.workspace, "game");
      const buildIdFile = path.join(clone, "dist", "build_id");
      if (!existsSync(buildIdFile)) throw new Error("no dist/build_id in your clone; run build.sh first");
      const buildId = (await readFile(buildIdFile, "utf8")).trim();
      const webRoot = resolveInWorkspace(clone, dir);
      if (!(await stat(webRoot)).isDirectory()) throw new Error(`"${dir}" is not a directory in your clone`);
      const files = new Map<string, Buffer>();
      await collectSiteFiles(realDirInsideClone(clone, webRoot, dir), "", include_hidden, files);
      const siteRoot = resolveInWorkspace(clone, site_dir);
      if (existsSync(siteRoot) && (await stat(siteRoot)).isDirectory())
        await collectSiteFiles(realDirInsideClone(clone, siteRoot, site_dir), "site/", include_hidden, files);
      if (files.size === 0) throw new Error(`"${dir}" is empty; nothing to deploy`);
      files.set("build_id.txt", Buffer.from(`${buildId}\n`, "utf8"));
      // Stable digest over sorted (name, bytes) pairs: the platform echoes it, so unchanged sites can be skipped.
      const digest = createHash("sha256");
      const map: Record<string, string> = {};
      for (const [name, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        map[name] = buf.toString("base64");
        digest.update(name).update(buf);
      }
      const d = await ctx.naive.apps.deploy(appId, map, digest.digest("hex"));
      const app = await ctx.naive.apps.get(appId);
      return { content: JSON.stringify({ deployment: d.id, status: d.status, url: d.url, app_url: app.url, build_id: buildId, files: files.size }) };
    } catch (e) {
      return { content: clip(`site deploy failed: ${errText(e)}`, 2000), is_error: true };
    }
  },
};

const siteStatus: ToolImpl = {
  description: "Read-only: the studio site's app status and URL, the latest deployment's build_id, and the last 5 deployments.",
  input: z.object({}).strict(),
  async run(_i, ctx) {
    if (!ctx.naive) return { content: "site_status needs a Naïve client (NAIVE_API_KEY)", is_error: true };
    const appId = process.env.STUDIO_SITE_APP_ID;
    if (!appId) return { content: "STUDIO_SITE_APP_ID is not set; the operator creates the studio app once (docs/naive-notes.md, Apps) and sets its id in env", is_error: true };
    try {
      const app = await ctx.naive.apps.get(appId);
      const deps = await ctx.naive.apps.deployments(appId, { limit: 5 });
      let buildId: string | null = null;
      if (deps.data[0]) {
        const kept = await ctx.naive.apps.deploymentFiles(appId, deps.data[0].id);
        const raw = kept.files["build_id.txt"];
        if (raw) buildId = Buffer.from(raw, "base64").toString("utf8").trim();
      }
      return {
        content: JSON.stringify({
          app: { id: app.id, name: app.name, status: app.status, url: app.url },
          build_id: buildId,
          deployments: deps.data.map((d) => ({ id: d.id, status: d.status, url: d.url, created_at: d.created_at })),
        }),
      };
    } catch (e) {
      return { content: clip(`site status failed: ${errText(e)}`, 2000), is_error: true };
    }
  },
};

// ---------- qa_harness: the QA contract driver (tools/qa) against this run's game clone ----------
// The launch command comes from the agent, validated to an argv of `godot` or a path inside the
// clone (never a shell string); timeouts are mandatory and come from the tool inputs.

/** Validate a game launch argv: strings only, first element `godot` (PATH) or inside the clone. */
export function validateLaunchArgv(argv: unknown, clone: string): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && a.length > 0)) {
    throw new Error("cmd must be a non-empty string[] argv (no shell strings)");
  }
  const bin = argv[0]!;
  if (bin === "godot") return argv;
  const resolved = path.resolve(clone, bin);
  const inside = resolved === clone || resolved.startsWith(clone + path.sep);
  // An absolute godot binary is the engine, wherever the operator put it (build.sh GODOT_BIN).
  const engineBin = path.basename(bin) === "godot" && path.isAbsolute(bin);
  if (!inside && !engineBin) throw new Error(`launch binary must be "godot", an absolute godot path, or a path inside the clone, got ${bin}`);
  if (!inside && !existsSync(bin)) throw new Error(`launch binary not found: ${bin}`);
  if (inside && !existsSync(resolved)) throw new Error(`launch binary not found: ${bin}`);
  return argv;
}

type QaMode = "smoke" | "check" | "determinism" | "export-check";

async function runQa(mode: QaMode, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; is_error?: boolean }> {
  try {
    const clone = path.join(ctx.workspace, "game");
    if (!existsSync(path.join(clone, "project.godot")) && mode !== "check") {
      throw new Error(`no game clone at ${path.relative(ctx.workspace, clone)}; call game_clone first`);
    }
    if (mode === "export-check") {
      const args = ["--dir", clone, "--dist", resolveInWorkspace(clone, typeof input["dist_dir"] === "string" ? input["dist_dir"] : "dist")];
      if (input["frames"] !== undefined) args.push("--frames", String(input["frames"]));
      args.push("--timeout-ms", String(input["timeout_ms"] ?? 180_000));
      if (input["run"] === false) args.push("--run", "false");
      if (input["save_frames"] !== undefined) args.push("--save-frames", String(input["save_frames"]), "--save-dir", mediaOut(ctx.workspace, "media/export-frames"));
      const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
      const proc = await execText(process.execPath, ["--import", `file://${tsxLoader}`, path.join(ROOT, "tools", "qa", "qa.ts"), "export-check", ...args], 15 * 60_000);
      try {
        const result = JSON.parse(proc.out);
        // saved frames are reported workspace-relative, the paths image_view takes
        for (const p of result.packs ?? []) if (Array.isArray(p.run?.saved_frames)) p.run.saved_frames = p.run.saved_frames.map((f: string) => path.relative(ctx.workspace, f));
        return { content: clip(JSON.stringify(result), MAX_RESULT_CHARS) };
      } catch {
        throw new Error(`qa export-check produced no JSON (exit ${proc.code}): ${proc.err.slice(-400)}`);
      }
    }
    const cli: Record<string, unknown> = {};
    const numArg = (k: string, v: unknown): number => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
      return n;
    };
    if (mode !== "check") {
      const cmd = validateLaunchArgv(input["cmd"], clone);
      cli["cmd"] = JSON.stringify(cmd);
      cli["dir"] = clone;
      cli["seed"] = numArg("seed", input["seed"] ?? 0);
      cli["ticks"] = numArg("ticks", input["ticks"] ?? 0);
      if (input["policy"] !== undefined) cli["policy"] = String(input["policy"]);
    } else {
      const dir = input["qa_dir"];
      cli["dir"] = typeof dir === "string" ? resolveInWorkspace(ctx.workspace, path.join("game", dir, "qa")) : path.join(clone, "qa");
    }
    // Mandatory caps (ms): a QA run can't hang the agent loop.
    cli["ack-timeout-ms"] = numArg("ack_timeout_ms", input["ack_timeout_ms"] ?? 30_000);
    if (input["ready_timeout_ms"] !== undefined) cli["ready-timeout-ms"] = numArg("ready_timeout_ms", input["ready_timeout_ms"]);
    cli["end-wait-ms"] = numArg("end_wait_ms", input["end_wait_ms"] ?? 120_000);
    if (input["step_frames"] !== undefined) cli["step-frames"] = numArg("step_frames", input["step_frames"]);
    if (input["max_entities"] !== undefined) cli["max-entities"] = numArg("max_entities", input["max_entities"]);
    if (input["identical_dumps"] !== undefined) cli["identical-dumps"] = numArg("identical_dumps", input["identical_dumps"]);
    if (input["tick_rate"] !== undefined) cli["tick-rate"] = numArg("tick_rate", input["tick_rate"]);

    const args = Object.entries(cli).flatMap(([k, v]) => [`--${k}`, String(v)]);
    // tsx resolves from the cwd; the child runs in the clone, so import the loader by path.
    const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
    const proc = await execText(process.execPath, ["--import", `file://${tsxLoader}`, path.join(ROOT, "tools", "qa", "qa.ts"), mode, ...args], 10 * 60_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(proc.out);
    } catch {
      throw new Error(`qa ${mode} produced no JSON (exit ${proc.code}): ${proc.err.slice(-400)}`);
    }
    if (proc.err.trim() && (proc.code !== 0 || /Error|throw/i.test(proc.err))) {
      // surface child stderr: a crashing game must not look like a silent verdict
      (parsed as Record<string, unknown>)["stderr_tail"] = proc.err.slice(-400);
    }
    return { content: clip(JSON.stringify(parsed), MAX_RESULT_CHARS) };
  } catch (e) {
    return { content: clip(`qa_${mode} failed: ${errText(e)}`, 2000), is_error: true };
  }
}

const commonFields = {
  ack_timeout_ms: z.number().int().positive().max(10 * 60_000).optional(),
  ready_timeout_ms: z.number().int().positive().max(10 * 60_000).optional(),
  end_wait_ms: z.number().int().positive().max(30 * 60_000).optional(),
  max_entities: z.number().int().positive().optional(),
  identical_dumps: z.number().int().positive().max(100).optional(),
  tick_rate: z.number().positive().optional(),
};

const qaSmoke: ToolImpl = {
  description:
    "Run one QA smoke on your game clone (game_clone first): launch + contract flags, pause/step/dump drive, every invariant. Returns the verdict JSON {ok, exitCode, checks[], error?, end?}; exitCode 0 pass, 1 invariant failure, 2 harness error.",
  input: z
    .object({
      cmd: z.array(z.string()).min(1).describe("Game launch argv, e.g. [\"godot\",\"--headless\",\"res://qa/driver.tscn\",\"--\"]"),
      seed: z.number().int().optional(),
      ticks: z.number().int().nonnegative().optional(),
      policy: z.string().optional(),
      step_frames: z.number().int().positive().optional(),
      ...commonFields,
    })
    .strict(),
  async run(input, ctx) {
    return runQa("smoke", input, ctx);
  },
};

const qaCheck: ToolImpl = {
  description:
    "Offline QA: run the invariants over the qa/ files a finished run left in your clone (qa/state.json, events.jsonl, run_summary.json). No game launch.",
  input: z
    .object({
      qa_dir: z.string().optional().describe("qa dir inside the clone; default the clone's qa/"),
      ...((({ ack_timeout_ms, ready_timeout_ms, end_wait_ms, ...rest }) => rest)(commonFields) as object),
    })
    .strict(),
  async run(input, ctx) {
    return runQa("check", input, ctx);
  },
};

const qaDeterminism: ToolImpl = {
  description:
    "Run the QA smoke twice with the same seed/policy and diff the final state dumps (first differing path). Same inputs as qa_smoke.",
  input: qaSmoke.input,
  async run(input, ctx) {
    return runQa("determinism", input, ctx);
  },
};

const qaExportCheck: ToolImpl = {
  description:
    "Release gate on the EXPORTED build (run build.sh build-web first): for dist/web/index.pck (and dist/windows/*.pck), checks every project.godot autoload is in the pack's file table, " +
    "then runs the pack natively (godot --main-pack, movie mode, opens a window briefly) and fails a blank last frame (< 5% non-background on the whole frame or the centre, or < 8 colours), " +
    "a non-zero exit, no frames, or engine load errors. Mandatory before a release: a project-dir pass alone is not a release pass. Verdict JSON {ok, exitCode, checks[], packs[]}.",
  input: z
    .object({
      dist_dir: z.string().optional().describe("dist dir inside the clone (default dist)"),
      frames: z.number().int().min(10).max(600).optional().describe("frames to render before the still (default 90 at 30 fps)"),
      timeout_ms: z.number().int().positive().max(10 * 60_000).optional().describe("per-pack engine timeout (default 180000)"),
      run: z.boolean().optional().describe("false = pack-table check only (no engine run)"),
      save_frames: z.number().int().min(1).max(12).optional().describe("copy this many evenly spaced rendered frames (always including the last) to media/export-frames/<pack>/ in your workspace, for image_view (UI review of the exported build)"),
    })
    .strict(),
  async run(input, ctx) {
    return runQa("export-check", input, ctx);
  },
};

const qaHarnessTools = { qa_smoke: qaSmoke, qa_check: qaCheck, qa_determinism: qaDeterminism, qa_export_check: qaExportCheck };

// ---------- media_capture (tools/media): stills, footage, and deterministic edits for marketing ----------
// Built against docs/contracts only. Inputs are workspace-relative (the game clone is <workspace>/game);
// outputs land under <workspace>/media/. The game is launched from the clone with cwd = the clone, and
// the launch command must be a file inside the clone or the engine binary (GODOT_BIN, default "godot").

const MEDIA_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A workspace path under media/ (outputs). */
function mediaOut(workspace: string, rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (!norm.startsWith("media/") || norm.includes("/../")) throw new Error(`outputs go under media/ in your workspace, got "${rel}"`);
  return resolveInWorkspace(workspace, norm);
}

// Launch args are allowlisted (review R16-2): engine flags that pick a renderer/driver or a window
// mode only. Anything that runs other code or another project (--script/-s, --main-pack, --editor,
// --path elsewhere, -e, --debug-server…) is refused.
const LAUNCH_FLAGS = new Set(["--headless", "--windowed"]);
const LAUNCH_VALUE_FLAGS = new Set(["--rendering-method", "--rendering-driver", "--display-driver", "--audio-driver"]);
const LAUNCH_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * The launch argv: the engine binary by name (GODOT_BIN, default "godot") run on the clone, or a
 * built desktop export under the clone's dist/ (build.md). Trust note: dist/ is inside an
 * agent-writable clone, so an agent that can also write there could plant its own executable.
 */
export function mediaLaunch(clone: string, launch: string[]): string[] {
  const [bin, ...rest] = launch;
  const engine = process.env.GODOT_BIN ?? "godot";
  const isEngine = bin === engine;
  let exe = bin;
  if (!isEngine) {
    exe = resolveInWorkspace(clone, bin);
    if (!exe.startsWith(path.join(clone, "dist") + path.sep)) throw new Error(`launch[0] must be the engine ("${engine}") or a desktop build under the clone's dist/ (build.sh output); "${bin}" is neither`);
    if (!existsSync(exe)) throw new Error(`launch[0] ${bin} does not exist in the clone (run build.sh first)`);
  }
  const out: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (LAUNCH_FLAGS.has(a)) out.push(a);
    else if (LAUNCH_VALUE_FLAGS.has(a) && LAUNCH_VALUE.test(rest[k + 1] ?? "")) out.push(a, rest[++k]);
    else if (isEngine && a === "--path") {
      const target = rest[++k] ?? "";
      if (resolveInWorkspace(clone, target) !== clone) throw new Error(`--path must be the game clone itself (".") , got "${target}"`);
      out.push(a, clone);
    } else throw new Error(`launch argument "${a}" is not allowed (allowed: ${[...LAUNCH_FLAGS, ...LAUNCH_VALUE_FLAGS].join(", ")}${isEngine ? ", --path ." : ""})`);
  }
  return [exe, ...out];
}

const mediaTools: Record<string, ToolImpl> = {
  media_capture: {
    description:
      "Capture from the running desktop build through the harness contracts: launches it from the game clone with " +
      "--qa --seed --time-scale --autoplay --policy --resolution. mode 'ticks': pause, step to each tick, screenshot. " +
      "mode 'events': screenshot when listed events fire (pause → dump_state → screenshot → resume). mode 'movie': engine " +
      "movie mode (--write-movie) until --exit-after-ticks. Stills/footage go to media/<name>/. Timeouts kill the game.",
    input: z
      .object({
        name: z.string().regex(MEDIA_NAME).describe("output folder media/<name>/"),
        mode: z.enum(["ticks", "events", "movie"]),
        launch: z.array(z.string().min(1)).min(1).max(12).describe('argv prefix: ["godot", "--path", "."] (engine on the clone) or ["dist/<target>/<game>"]; extra args only --headless, --windowed, --rendering-method/--rendering-driver/--display-driver/--audio-driver <name>'),
        separator: z.literal("--").optional().describe('put "--" between engine args and game flags (Godot user args)'),
        seed: z.number().int().nonnegative(),
        time_scale: z.number().min(0.1).max(20).default(1),
        policy: z.string().regex(MEDIA_POLICY).describe("random | greedy | script:PATH (PATH relative to the game clone)"),
        width: z.number().int().min(64).max(3840).default(1280),
        height: z.number().int().min(64).max(2160).default(720),
        ticks: z.array(z.number().int().nonnegative()).min(1).max(60).optional().describe("mode ticks"),
        triggers: z.array(z.object({ event: z.string().min(1).max(40), every: z.number().int().min(1).optional(), max: z.number().int().min(1).optional() }).strict()).min(1).max(10).optional().describe("mode events"),
        max_shots: z.number().int().min(1).max(60).default(12),
        exit_after_ticks: z.number().int().min(1).optional().describe("mode movie (required)"),
        movie_file: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}\.avi$/).default("footage.avi"),
        timeout_s: z.number().int().min(5).max(1800).default(300),
      })
      .strict(),
    async run(i, ctx) {
      try {
        const clone = path.join(ctx.workspace, "game");
        if (!existsSync(clone)) throw new Error("no clone yet; call game_clone first");
        if (i.policy.startsWith("script:")) {
          const script = resolveInWorkspace(clone, i.policy.slice("script:".length));
          if (!existsSync(script)) throw new Error(`policy script ${i.policy.slice(7)} does not exist in the game clone`);
        }
        const outDir = mediaOut(ctx.workspace, `media/${i.name}`);
        let mode: CaptureMode;
        if (i.mode === "ticks") {
          if (!i.ticks) throw new Error("mode ticks needs ticks");
          mode = { kind: "ticks", ticks: i.ticks };
        } else if (i.mode === "events") {
          if (!i.triggers) throw new Error("mode events needs triggers");
          mode = { kind: "events", triggers: i.triggers, max_shots: i.max_shots };
        } else {
          if (!i.exit_after_ticks) throw new Error("mode movie needs exit_after_ticks");
          mode = { kind: "movie", file: path.join(outDir, i.movie_file), exit_after_ticks: i.exit_after_ticks };
        }
        const r = await mediaCapture({
          gameDir: clone, launch: mediaLaunch(clone, i.launch), separator: i.separator, seed: i.seed, timeScale: i.time_scale,
          policy: i.policy, resolution: { w: i.width, h: i.height }, outDir, mode, timeoutMs: i.timeout_s * 1000,
        });
        const rel = (f: string) => path.relative(ctx.workspace, f);
        return {
          content: clip(JSON.stringify({
            shots: r.shots.map((s) => ({ ...s, file: rel(s.file) })),
            movie: r.movie ? { file: rel(r.movie.file), bytes: r.movie.bytes } : undefined,
            exit: r.exit, events_seen: r.events_seen, notes: r.notes,
          })),
        };
      } catch (e) {
        return { content: clip(errText(e), 4000), is_error: true };
      }
    },
  },
  media_edit: {
    description:
      "Execute an edit plan (a JSON file you wrote in your workspace) with ffmpeg: clips {source,start_s,end_s} or " +
      "{still: PNG, duration_s} in order, nearest-neighbour scaling to output width×height (letterboxed), fixed fps, " +
      "mp4 (H.264 yuv420p) or GIF (palettegen/paletteuse), optional max_bytes/max_duration_s caps. Output path under media/.",
    input: z.object({ plan: z.string().min(1).describe("workspace-relative plan JSON: {schema_version:1, clips:[…], output:{path,format,width,height,fps,max_bytes?,max_duration_s?}}") }).strict(),
    async run({ plan }, ctx) {
      try {
        const planJson = JSON.parse(await readFile(resolveInWorkspace(ctx.workspace, plan), "utf8"));
        const r = await mediaEdit(planJson, { resolveInput: (rel) => resolveInWorkspace(ctx.workspace, rel), resolveOutput: (rel) => mediaOut(ctx.workspace, rel) });
        return { content: JSON.stringify({ ...r, out: path.relative(ctx.workspace, r.out) }) };
      } catch (e) {
        return { content: clip(errText(e), 4000), is_error: true };
      }
    },
  },
  media_probe: {
    description: "ffprobe summary of a media file in your workspace: format, duration, size, video codec/size/fps/pix_fmt/frames, audio.",
    input: z.object({ path: z.string().min(1) }).strict(),
    async run({ path: rel }, ctx) {
      try {
        return { content: JSON.stringify(await mediaProbe(resolveInWorkspace(ctx.workspace, rel))) };
      } catch (e) {
        return { content: clip(errText(e), 2000), is_error: true };
      }
    },
  },
};

/** Core implementations; lane IMPLS (runner/tools/lanes/) are merged in below. */
const CORE_IMPLS: Record<keyof typeof CORE_CAPABILITIES, Record<string, ToolImpl>> = {
  catalog_query: catalogTools,
  gap_map: gapTools,
  steam_reviews: reviewTools,
  studio_ledger: ledgerTools,
  studio_status: studioStatusTools,
  web_fetch: { web_fetch: webFetch },
  web_search: { web_search: webSearch },
  workspace_read: { workspace_read: workspaceRead },
  workspace_write: { workspace_write: workspaceWrite },
  image_view: { art_view: artView },
  game_repo: gameRepoTools,
  qa_harness: qaHarnessTools,
  art_tools: artTools,
  art_generate: { art_generate: artGenerate, art_quote: artQuote, art_anchor_winner: artAnchorWinner, art_providers: artProviders },
  itch_push: { itch_push: itchPush },
  itch_status: { itch_status: itchStatus },
  email_send: { email_send: emailSend },
  site_deploy: { site_deploy: siteDeploy },
  site_status: { site_status: siteStatus },
  art_signoff: { art_signoff: artSignoff },
  board: boardTools,
  media_capture: mediaTools,
};

/** Each capability provides one or more model-facing tools: core + every lane (merge.ts refuses redefinitions and shadowed tool names). */
export const IMPLS = mergeImpls(CORE_IMPLS, LANES) as Record<CapabilityName, Record<string, ToolImpl>>;

/** Model-facing tool name → its capability and implementation. */
export const TOOL_INDEX: Record<string, { capability: CapabilityName; impl: ToolImpl }> = Object.fromEntries(
  (Object.entries(IMPLS) as [CapabilityName, Record<string, ToolImpl>][]).flatMap(([capability, tools]) =>
    Object.entries(tools).map(([name, impl]) => [name, { capability, impl }]),
  ),
);
