// Local implementations of the capabilities in registry.ts.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CapabilityName } from "./registry.ts";
import type { NaiveClient } from "../providers.ts";
import { studioStatusTools } from "./studio-status.ts";
import { append as ledgerAppend, read as ledgerRead, LEDGER_FILE } from "../../tools/ledger/ledger.ts";

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
export function resolveInWorkspace(workspace: string, rel: string): string {
  const p = path.resolve(workspace, rel || ".");
  if (p !== workspace && !p.startsWith(workspace + path.sep)) throw new Error(`path escapes the workspace: ${rel}`);
  return p;
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
  return { clone, branch, src };
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
        content: JSON.stringify({ game: src.name, clone: path.relative(ctx.workspace, clone), branch, head: head.out.trim(), main: "main" }),
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
      execFile(cmd, args, { cwd, timeout: (timeout_s ?? 120) * 1000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  game_repo: gameRepoTools,
};

/** Model-facing tool name → its capability and implementation. */
export const TOOL_INDEX: Record<string, { capability: CapabilityName; impl: ToolImpl }> = Object.fromEntries(
  (Object.entries(IMPLS) as [CapabilityName, Record<string, ToolImpl>][]).flatMap(([capability, tools]) =>
    Object.entries(tools).map(([name, impl]) => [name, { capability, impl }]),
  ),
);
