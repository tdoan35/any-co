// Steam user reviews for Greenlight: fetch (cached), keyword mention rates, monthly trend.
// The old JSON endpoint (store.steampowered.com/appreviews) now redirects to the store home, so
// reviews come from the public Steam Community review pages, paged with their cursor form.
//   node --import tsx tools/steam-reviews/reviews.ts fetch --appid N [--kind negative] [--sort toprated] [--n 50]
//   ... mentions --appid N --kind negative --terms "short,price,bugs" | trend --appid N
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CACHE_DIR = path.join(ROOT, "data", "reviews-cache");
const UA = "Mozilla/5.0 (Macintosh; any-co-studio research)";
const CACHE_DAYS = 7;
const MIN_GAP_MS = 900; // be polite: about one request per second
export const MAX_REVIEWS = 100;

export type Kind = "positive" | "negative";
export type Sort = "toprated" | "mostrecent";
// Steam Community "appHubSubSection" ids for review lists.
const SECTION: Record<Kind, number> = { positive: 16, negative: 17 };

export interface Review {
  id: string; // author path, unique per app: "id/<name>" or "profiles/<steamid>"
  voted_up: boolean;
  hours: number | null; // hours on record
  posted: string | null; // as shown, e.g. "March 10, 2024"
  helpful: number;
  early_access: boolean;
  free_copy: boolean;
  text: string;
}

export interface ReviewSet {
  appid: number;
  kind: Kind;
  sort: Sort;
  fetched_at: string;
  reviews: Review[];
  exhausted: boolean; // Steam had no more reviews to give
}

let lastRequest = 0;
async function get(url: string): Promise<string> {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US" }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e: any) {
      if (attempt >= 4 || (!e.retry && !/fetch failed|timeout|ECONNRESET|aborted/i.test(String(e?.message) + String(e?.cause?.code)))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export function cleanReviewHtml(h: string): string {
  return decode(
    h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Parse review cards from a Community review page or homecontent fragment. */
export function parseCards(html: string): Review[] {
  const out: Review[] = [];
  const parts = html.split(/<div[^>]*class="apphub_Card modalContentLink[^"]*"/).slice(1);
  for (const p of parts) {
    const url = /data-modal-content-url="https:\/\/steamcommunity\.com\/((?:id|profiles)\/[^/"]+)\/recommended\//.exec(p);
    const title = /<div class="title">([^<]+)<\/div>/.exec(p);
    if (!url || !title) continue;
    const hours = /<div class="hours">([\d,.]+) hrs on record/.exec(p);
    const posted = /<div class="date_posted">Posted:\s*([^<]+)<\/div>/.exec(p);
    const helpful = /([\d,]+) (?:people|person) found this review helpful/.exec(p);
    const body = /<div class="apphub_CardTextContent">([\s\S]*?)<\/div>\s*(?:<div class="UserReviewCardContent_Footer"|<\/div>)/.exec(p);
    let text = body ? body[1].replace(/<div class="date_posted">[\s\S]*?<\/div>/, "") : "";
    const early = /early_access_review/.test(text) || /Early Access Review/.test(p);
    text = text.replace(/<div class="early_access_review">[\s\S]*?<\/div>/, "");
    out.push({
      id: url[1],
      voted_up: title[1].trim() === "Recommended",
      hours: hours ? Number(hours[1].replace(/,/g, "")) : null,
      posted: posted ? posted[1].trim() : null,
      helpful: helpful ? Number(helpful[1].replace(/,/g, "")) : 0,
      early_access: early,
      free_copy: /Product received for free/i.test(p),
      text: cleanReviewHtml(text),
    });
  }
  return out;
}

function formValue(html: string, name: string): string | null {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? decode(m[1]) : null;
}

function cacheFile(appid: number, kind: Kind, sort: Sort) {
  return path.join(CACHE_DIR, `${appid}-${kind}-${sort}.json`);
}

/** Up to n reviews of one kind, from cache when fresh. */
export async function fetchReviews(appid: number, kind: Kind, sort: Sort = "toprated", n = 50): Promise<ReviewSet> {
  n = Math.min(Math.max(1, n), MAX_REVIEWS);
  const file = cacheFile(appid, kind, sort);
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, "utf8")) as ReviewSet;
    const fresh = Date.now() - Date.parse(c.fetched_at) < CACHE_DAYS * 86_400_000;
    if (fresh && (c.reviews.length >= n || c.exhausted)) return { ...c, reviews: c.reviews.slice(0, n) };
  }
  const listPage = kind === "negative" ? "negativereviews" : "positivereviews";
  let html = await get(`https://steamcommunity.com/app/${appid}/${listPage}/?browsefilter=${sort}&filterLanguage=english&p=1`);
  const seen = new Set<string>();
  const reviews: Review[] = [];
  let exhausted = false;
  for (let page = 1; reviews.length < n; page++) {
    const cards = parseCards(html).filter((r) => r.voted_up === (kind === "positive") && !seen.has(r.id));
    for (const r of cards) { seen.add(r.id); reviews.push(r); }
    const cursor = formValue(html, "userreviewscursor");
    const offset = formValue(html, "userreviewsoffset");
    const next = formValue(html, "p");
    if (!cards.length || !cursor || !next || page >= 15) { exhausted = !cards.length || !cursor; break; }
    const q = new URLSearchParams({
      userreviewscursor: cursor, userreviewsoffset: offset ?? String(reviews.length), p: next,
      numperpage: "10", browsefilter: sort, l: "english", appHubSubSection: String(SECTION[kind]),
      filterLanguage: "english", searchText: "", maxInappropriateScore: "100", forceanon: "1",
    });
    for (const k of ["workshopitemspage", "readytouseitemspage", "mtxitemspage", "itemspage", "screenshotspage", "videospage", "artpage", "allguidepage", "webguidepage", "integratedguidepage", "discussionspage"]) q.set(k, next);
    html = await get(`https://steamcommunity.com/app/${appid}/homecontent/?${q}`);
  }
  const set: ReviewSet = { appid, kind, sort, fetched_at: new Date().toISOString(), reviews: reviews.slice(0, MAX_REVIEWS), exhausted };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(set));
  return { ...set, reviews: set.reviews.slice(0, n) };
}

/** Summary stats for a sample, computed in code. */
export function summarize(reviews: Review[]) {
  const hrs = reviews.map((r) => r.hours).filter((h): h is number => h !== null).sort((a, b) => a - b);
  return {
    count: reviews.length,
    median_hours: hrs.length ? hrs[Math.floor(hrs.length / 2)] : null,
    under_2h_share: hrs.length ? Math.round((hrs.filter((h) => h < 2).length / hrs.length) * 1000) / 1000 : null,
    early_access_share: reviews.length ? Math.round((reviews.filter((r) => r.early_access).length / reviews.length) * 1000) / 1000 : 0,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Share of reviews mentioning each term (case-insensitive, word-start match, so "bug" also
 * matches "bugs" and "buggy"). "a|b" counts a review that mentions either.
 */
export function mentions(reviews: Review[], terms: string[]) {
  return terms.map((term) => {
    const alts = term.split("|").map((t) => t.trim()).filter(Boolean);
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${alts.map(escapeRe).join("|")})`, "iu");
    const hits = reviews.filter((r) => re.test(r.text));
    const examples = hits.slice(0, 3).map((r) => {
      const m = re.exec(r.text)!;
      const at = m.index + m[1].length;
      const start = Math.max(0, at - 120), end = Math.min(r.text.length, at + 160);
      return { review_id: r.id, snippet: (start > 0 ? "…" : "") + r.text.slice(start, end).replace(/\s+/g, " ") + (end < r.text.length ? "…" : "") };
    });
    return { term, count: hits.length, sample_size: reviews.length, share: reviews.length ? Math.round((hits.length / reviews.length) * 1000) / 1000 : 0, examples };
  });
}

/** Monthly positive/negative review counts (Steam's review histogram), last `months` months. */
export async function trend(appid: number, months = 24) {
  const j = JSON.parse(await get(`https://store.steampowered.com/appreviewhistogram/${appid}?l=english&review_score_preference=0`));
  if (!j.success) throw new Error(`no review histogram for ${appid}`);
  const rows = (j.results?.rollups ?? []).map((r: any) => ({
    month: new Date(r.date * 1000).toISOString().slice(0, 7), up: r.recommendations_up, down: r.recommendations_down,
  }));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const recent = rows.filter((r: any) => r.month < thisMonth).slice(-months); // drop the partial current month
  const sum = (a: typeof rows) => a.reduce((s: number, r: any) => s + r.up + r.down, 0);
  const last6 = sum(recent.slice(-6)), prev6 = sum(recent.slice(-12, -6));
  return {
    appid,
    rollup_type: j.results?.rollup_type ?? null,
    months: recent,
    last_6_vs_prior_6: prev6 ? Math.round((last6 / prev6) * 100) / 100 : null, // review volume ratio: >1 = growing attention
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { appid: { type: "string" }, kind: { type: "string", default: "negative" }, sort: { type: "string", default: "toprated" }, n: { type: "string", default: "30" }, terms: { type: "string" } },
  });
  const appid = Number(values.appid);
  const kind = values.kind as Kind, sort = values.sort as Sort;
  let out: unknown;
  if (positionals[0] === "fetch") {
    const s = await fetchReviews(appid, kind, sort, Number(values.n));
    out = { ...summarize(s.reviews), reviews: s.reviews.map((r) => ({ ...r, text: r.text.slice(0, 300) })) };
  } else if (positionals[0] === "mentions") {
    out = mentions((await fetchReviews(appid, kind, sort, MAX_REVIEWS)).reviews, (values.terms ?? "").split(","));
  } else if (positionals[0] === "trend") out = await trend(appid);
  else {
    console.error("usage: reviews.ts fetch|mentions|trend --appid N [--kind negative|positive] [--sort toprated|mostrecent] [--n 30] [--terms a,b]");
    process.exit(2);
  }
  console.log(JSON.stringify(out, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
