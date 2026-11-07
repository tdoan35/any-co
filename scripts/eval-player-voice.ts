// Mechanical eval of one Player Voice Analyst run. Usage: npm run eval:player-voice -- runs/<run_id>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR, MAX_REVIEWS, fetchReviews, mentions, type Review } from "../tools/steam-reviews/reviews.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) {
  console.error("usage: npm run eval:player-voice -- runs/<run_id>");
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
if (!existsSync(path.join(dir, "output.json"))) {
  console.log(`run ${run.status}: no output${run.error ? ` (${String(run.error).split("\n")[0]})` : ""}`);
  process.exit(1);
}
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const transcript = readFileSync(path.join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const tools = transcript.filter((e) => e.type === "tool");
const taskAppids = new Set([...String(run.task).matchAll(/appid (\d+)/g)].map((m) => Number(m[1])));

// Every cached review for an appid, any kind/sort, by id.
const reviewsOf = new Map<number, Map<string, Review>>();
function cached(appid: number) {
  if (!reviewsOf.has(appid)) {
    const m = new Map<string, Review>();
    if (existsSync(CACHE_DIR)) for (const f of readdirSync(CACHE_DIR).filter((f) => f.startsWith(`${appid}-`))) {
      for (const r of JSON.parse(readFileSync(path.join(CACHE_DIR, f), "utf8")).reviews as Review[]) m.set(r.id, r);
    }
    reviewsOf.set(appid, m);
  }
  return reviewsOf.get(appid)!;
}
const norm = (s: string) => s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
/** Verbatim with elisions: "..." or "…" may join excerpts; each excerpt must appear, in order. */
function quoteMatches(text: string, quote: string): boolean {
  const t = norm(text);
  const parts = norm(quote).split(/\s*(?:\.\.\.|…)\s*/).map((p) => p.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  let at = 0;
  for (const p of parts) {
    const i = t.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return parts.length > 0;
}
const mentionCalls = tools.filter((e) => e.name === "reviews_mentions" && !e.is_error);

let quotesOk = 0, quotesTotal = 0, sizedOk = 0, sizedTotal = 0, gamesOk = 0, gamesTotal = 0;
const report: any[] = [];
for (const seg of out.segments) {
  const issues: string[] = [];
  for (const g of seg.games_read) {
    gamesTotal++;
    if (taskAppids.has(g.appid)) gamesOk++; else issues.push(`games_read ${g.appid} (${g.name}) is not a comparable in the task`);
  }
  const findings = [...seg.wants.map((f: any) => ["want", f]), ...seg.loves.map((f: any) => ["love", f]), ...seg.deal_breakers.map((f: any) => ["deal_breaker", f])];
  for (const [kind, f] of findings) {
    for (const q of f.quotes) {
      quotesTotal++;
      const r = cached(q.appid).get(q.review_id);
      if (!r) issues.push(`${kind} "${f.statement.slice(0, 40)}": review ${q.review_id} not found for ${q.appid}`);
      else if (!quoteMatches(r.text, q.quote)) issues.push(`${kind} "${f.statement.slice(0, 40)}": quote not verbatim in ${q.review_id}: "${q.quote.slice(0, 60)}"`);
      else quotesOk++;
    }
    sizedTotal++;
    const s = f.sized_by;
    const ran = mentionCalls.some((e) => e.input.appid === s.appid && e.input.kind === s.kind && e.input.terms.includes(s.term));
    const set = await fetchReviews(s.appid, s.kind, "toprated", MAX_REVIEWS);
    const [m] = mentions(set.reviews, [s.term]);
    const why = !ran ? "term never passed to reviews_mentions in this run"
      : m.count !== s.count || m.sample_size !== s.sample_size || Math.abs(m.share - s.share) > 1e-3 ? `agent ${s.count}/${s.sample_size} (${s.share}) vs recount ${m.count}/${m.sample_size} (${m.share})`
      : null;
    if (why) issues.push(`${kind} "${f.statement.slice(0, 40)}" sized_by "${s.term}": ${why}`); else sizedOk++;
  }
  report.push({
    gap: seg.gap_label, games: seg.games_read.map((g: any) => g.name),
    wants: seg.wants.map((f: any) => `${f.statement} [${f.sized_by.term}: ${Math.round(f.sized_by.share * 100)}% of ${f.sized_by.sample_size} ${f.sized_by.kind}]`),
    loves: seg.loves.map((f: any) => `${f.statement} [${Math.round(f.sized_by.share * 100)}%]`),
    deal_breakers: seg.deal_breakers.map((f: any) => `${f.statement} [${Math.round(f.sized_by.share * 100)}%]`),
    issues,
  });
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns, spent_usd: run.spent_micro_usd / 1e6,
  tool_calls: Object.fromEntries(["reviews_fetch", "reviews_mentions", "reviews_trend"].map((n) => [n, tools.filter((e) => e.name === n).length])),
  tool_errors: tools.filter((e) => e.is_error || e.error).length,
  segments: `${out.segments.length} of ${taskAppids.size ? [...String(run.task).matchAll(/^## /gm)].length : "?"}`,
  quotes_verbatim_pct: pct(quotesOk, quotesTotal),
  sizes_verified_pct: pct(sizedOk, sizedTotal),
  games_from_task_pct: pct(gamesOk, gamesTotal),
  pass: quotesOk === quotesTotal && sizedOk === sizedTotal && gamesOk === gamesTotal,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify({ summary, segments: report }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const s of report) {
  console.log(`\n## ${s.gap}  (read: ${s.games.join(", ")})`);
  for (const w of s.wants) console.log(`  want  ${w}`);
  for (const l of s.loves) console.log(`  love  ${l}`);
  for (const d of s.deal_breakers) console.log(`  quit  ${d}`);
  for (const i of s.issues) console.log(`  ! ${i}`);
}
