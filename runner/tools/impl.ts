// Local implementations of the capabilities in registry.ts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CapabilityName } from "./registry.ts";
import type { NaiveClient } from "../providers.ts";
import { studioStatusTools } from "./studio-status.ts";
import { decodePng, encodePng, type RgbaImage } from "../../tools/art/png.ts";
import { addOutline, contactSheet, lockPalette, snapToGrid, splitStrip, upscaleNearest } from "../../tools/art/ops.ts";
import { runGate } from "../../tools/art/gate.ts";
import { append as ledgerAppend, read as ledgerRead, LEDGER_FILE } from "../../tools/ledger/ledger.ts";
import type { ImageBlock } from "../types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ToolContext {
  workspace: string; // absolute; the only place workspace_* tools can touch
  naive: NaiveClient | null;
  agent?: string; // set by the runner, for attribution in the ledger
  run_id?: string;
  runsDir?: string; // where runs/ lives (studio_status); defaults to <repo>/runs
  ledgerFile?: string; // studio ledger path (studio_ledger); defaults to <repo>/runs/ledger.jsonl
  gameRepoRoot?: string; // where games/ lives (game_repo); defaults to <repo>/games
}

export interface ToolOutput {
  content: string;
  /** Optional image the model must see next to the text (a ref block; no base64 here). */
  image?: ImageBlock;
  is_error?: boolean;
  cost_micro_usd?: number;
}

export interface ToolImpl {
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
}

const MAX_RESULT_CHARS = 40_000;
export function clip(s: string, max = MAX_RESULT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

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
      return { content: JSON.stringify({ total: all.length, counts, recent: all.slice(-limit).reverse() }) };
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
// Symlink-safe confinement. Returns the lexically normalised path (so `..` after a symlink is never
// handed to the OS), after checking that what the OS would actually touch stays under the root's
// realpath: the target's realpath when it exists, else the realpath of its deepest existing ancestor.
// A dangling symlink anywhere on the path is refused, since a write would follow it to wherever it points.
// Known limit: check-then-use, so a symlink swapped in between the check and the fs call is not caught.
export function resolveInWorkspace(workspace: string, rel: string): string {
  const p = path.resolve(workspace, rel || ".");
  if (p !== workspace && !p.startsWith(workspace + path.sep)) throw new Error(`path escapes the workspace: ${rel}`);
  const rootReal = realOrNull(workspace) ?? path.resolve(workspace);
  for (let cur = p; ; cur = path.dirname(cur)) {
    const real = realOrNull(cur);
    if (real !== null) {
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`path escapes the workspace through a symlink: ${rel}`);
      return p;
    }
    if (lstatOk(cur)) throw new Error(`path goes through a dangling symlink: ${rel}`);
    if (cur === workspace || path.dirname(cur) === cur) return p; // root not created yet: nothing on disk to follow
  }
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function lstatOk(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

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
      let scaleNote = "";
      if (upscale) {
        const k = Math.min(upscale, Math.floor(MAX_IMAGE_SIDE / Math.max(img.width, img.height)));
        if (k > 1) {
          const up = upscaleNearest(img, k);
          scaleNote = ` → ${up.width}×${up.height} (x${k} nearest-neighbour)`;
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

/** The one game repo the run works on: games/<name> (a git repo with >=1 commit). */
export function resolveGameRepo(root: string, repo?: string): { name: string; dir: string } {
  if (repo) {
    const dir = path.join(root, repo);
    if (!existsSync(path.join(dir, ".git"))) throw new Error(`games/${repo} is not a git repo`);
    return { name: repo, dir };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((d) => existsSync(path.join(root, d, ".git")));
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

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function gameCloneDir(ctx: ToolContext, repo?: string): Promise<{ clone: string; branch: string; src: { name: string; dir: string } }> {
  const src = resolveGameRepo(ctx.gameRepoRoot ?? path.join(ROOT, "games"), repo);
  const clone = path.join(ctx.workspace, "game");
  const branch = `agent/${ctx.agent ?? "unknown"}`;
  if (!existsSync(clone)) {
    const { code, err } = await execText("git", ["clone", "--quiet", src.dir, clone], 60_000);
    if (code !== 0) throw new Error(`git clone failed: ${err}`);
    const b = await execText("git", ["-C", clone, "checkout", "--quiet", "-b", branch], 30_000);
    if (b.code !== 0) throw new Error(`git checkout -b failed: ${b.err}`);
  }
  await copyContracts(ctx.workspace);
  return { clone, branch, src };
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
    "Read/write/run there with game_read, game_write, game_exec. You never touch the main repo directly; the Tech Lead merges branches.",
  input: z.object({ repo: z.string().min(1).max(80).optional().describe("Repo name under games/; omit when the studio has exactly one") }).strict(),
  async run({ repo }, ctx) {
    try {
      const { clone, branch, src } = await gameCloneDir(ctx, repo);
      const head = await execText("git", ["-C", clone, "rev-parse", "--short", "HEAD"], 15_000);
      return {
        content: JSON.stringify({
          game: src.name, clone: path.relative(ctx.workspace, clone), branch, head: head.out.trim(), main: "main",
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
      execFile(cmd, args, { cwd, env, timeout: (timeout_s ?? 120) * 1000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ out: String(stdout), err: String(stderr), code: typeof error?.code === "number" ? error.code : error ? 1 : 0 });
      });
      const r = await promise;
      return {
        content: clip(`exit ${r.code}\n${r.out}${r.err ? `\nstderr:\n${r.err}` : ""}`),
        is_error: r.code !== 0,
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

/** Each capability provides one or more model-facing tools. */
export const IMPLS: Record<CapabilityName, Record<string, ToolImpl>> = {
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
  art_tools: artTools,
  itch_push: { itch_push: itchPush },
  itch_status: { itch_status: itchStatus },
  email_send: { email_send: emailSend },
  site_deploy: { site_deploy: siteDeploy },
  site_status: { site_status: siteStatus },
};

/** Model-facing tool name → its capability and implementation. */
export const TOOL_INDEX: Record<string, { capability: CapabilityName; impl: ToolImpl }> = Object.fromEntries(
  (Object.entries(IMPLS) as [CapabilityName, Record<string, ToolImpl>][]).flatMap(([capability, tools]) =>
    Object.entries(tools).map(([name, impl]) => [name, { capability, impl }]),
  ),
);
