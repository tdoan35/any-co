// Mechanical eval of one Market Analyst run. Usage: npm run eval:market-analyst -- runs/<run_id>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runCatalog } from "../runner/tools/impl.ts";
import { gapScore, rankByScore } from "../tools/greenlight/score.ts";
import { probe, loadMap } from "../tools/gapmap/query.ts";

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, "run.json"))) {
  console.error("usage: npm run eval:market-analyst -- runs/<run_id>");
  process.exit(2);
}
const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
const transcript = readFileSync(path.join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (!existsSync(path.join(dir, "output.json"))) {
  console.log(`run ${run.status}: no output to evaluate${run.error ? ` (${String(run.error).split("\n")[0]})` : ""}`);
  process.exit(1);
}
const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8"));
const simplify = (s: string) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const q = async (argv: string[]) => JSON.parse((await runCatalog(argv)).content);

// Everything the agent could have seen on the web during the run.
const norm = (u: string) => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/$/, "").toLowerCase(); } catch { return u; }
};
const toolEvents = transcript.filter((e) => e.type === "tool");
const isCatalog = (n: string) => n === "catalog_query" || n.startsWith("catalog_");
const seenWeb = new Set<string>();
for (const e of toolEvents.filter((e) => e.name === "web_search" || e.name === "web_fetch")) {
  for (const m of String(e.content ?? "").matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) seenWeb.add(norm(m[0]));
  if (e.input?.url) seenWeb.add(norm(e.input.url));
}

const FIELDS = ["supply", "traction", "hit_rate", "demand", "median_reviews", "p90_reviews", "median_price_paid", "demand_pct", "supply_pct", "opportunity"];
let fieldsOk = 0, fieldsTotal = 0, compOk = 0, compTotal = 0, srcOk = 0, srcTotal = 0, mapOk = 0, mapTotal = 0;
const probedTexts = new Set(toolEvents.filter((e) => e.name === "gapmap_probe" && !e.is_error).map((e) => e.input?.text));
const regionIds = new Set(loadMap().map.regions.map((r) => r.id));
// Map-sourced gaps: a comparable may come from the region (or the probe's nearest games) instead of carrying every tag.
const gameRegion = new Map(loadMap().map.games.map((g) => [g.appid, g.region]));
const openedRegions = new Set(toolEvents.filter((e) => e.name === "gapmap_region" && !e.is_error).map((e) => e.input?.id));
const gaps: any[] = [];
// Newer runs submit judgments only; code (tools/greenlight/enrich.ts) adds evidence and map numbers.
const enriched = !!out.enriched_by;
for (const [i, g] of out.gaps.entries()) {
  const niche = await q(["niche", "--tags", g.tags.join(","), "--limit", "1"]);
  const issues: string[] = [];
  let truth: any = null;
  if (niche.error) issues.push(`tags: ${niche.error}`);
  else if (enriched) truth = niche.window_stats;
  else {
    truth = niche.window_stats;
    for (const f of FIELDS) {
      fieldsTotal++;
      const a = g.evidence[f], b = truth[f];
      const ok = a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-3);
      if (ok) fieldsOk++; else issues.push(`evidence.${f}: agent ${a} vs catalog ${b}`);
    }
  }
  for (const c of g.comparables) {
    compTotal++;
    const game = await q(["game", "--appid", String(c.appid)]);
    const inMapGap = g.map?.region_id != null && (gameRegion.get(c.appid) === g.map.region_id || (g.map.nearest ?? []).includes(game.name));
    const why = game.error ? "not found"
      : !inMapGap && !g.tags.every((t: string) => game.tags.includes(t)) ? `missing tags ${g.tags.filter((t: string) => !game.tags.includes(t))}${g.map?.region_id != null ? ` and not in region ${g.map.region_id}` : ""}`
      : game.reviews_total !== c.reviews_total ? `reviews ${c.reviews_total} vs ${game.reviews_total}`
      : !simplify(game.name).includes(simplify(c.name).slice(0, 12)) ? `name "${c.name}" vs "${game.name}"`
      : null;
    if (why) issues.push(`comparable ${c.appid}: ${why}`); else compOk++;
  }
  for (const s of g.momentum.sources) {
    srcTotal++;
    if (seenWeb.has(norm(s))) srcOk++; else issues.push(`source not seen in run: ${s}`);
  }
  let xy: [number, number] | null = null;
  if (g.map) {
    mapTotal++;
    const why: string[] = [];
    if (!probedTexts.has(g.map.probe_text)) why.push("probe_text was never probed in this run");
    if (g.map.region_id !== null && !regionIds.has(g.map.region_id)) why.push(`region ${g.map.region_id} does not exist`);
    if (enriched) {
      xy = g.map.xy ?? null;
      if (g.map.probe_error) why.push(`enrichment probe failed: ${g.map.probe_error}`);
    } else {
      const re = (await probe(g.map.probe_text)).result;
      xy = re.xy;
      if (Math.abs(re.novelty_pct - g.map.novelty_pct) > 0.02) why.push(`map.novelty_pct: agent ${g.map.novelty_pct} vs re-probe ${re.novelty_pct}`);
      if (re.region.id !== g.map.probe_region_id) why.push(`map.probe_region_id: agent ${g.map.probe_region_id} vs re-probe ${re.region.id}`);
    }
    if (why.length) issues.push(...why); else mapOk++;
  }
  if (g.map?.region_id != null && !openedRegions.has(g.map.region_id)) issues.push(`map.region_id ${g.map.region_id} was never opened with gapmap_region (copied from the probe?)`);
  const score = truth && truth.demand_pct !== undefined
    ? gapScore({ demand_pct: truth.demand_pct, supply_pct: truth.supply_pct, feasibility: g.feasibility.score, marketability: g.marketability.score })
    : 0;
  gaps.push({ agent_rank: i + 1, label: g.label, tags: g.tags, score, feasibility: g.feasibility.score, marketability: g.marketability.score, momentum: g.momentum.direction, map: g.map ? { region_id: g.map.region_id, probe_region_id: g.map.probe_region_id ?? g.map.probe_region?.id, novelty_pct: g.map.novelty_pct, xy } : null, issues });
}

const dupes: string[] = [];
for (let i = 0; i < out.gaps.length; i++) for (let j = i + 1; j < out.gaps.length; j++) {
  const a = new Set(out.gaps[i].tags), b = new Set(out.gaps[j].tags);
  const inter = [...a].filter((t) => b.has(t)).length;
  const jac = inter / new Set([...a, ...b]).size;
  if (jac >= 0.67) dupes.push(`${out.gaps[i].label} ~ ${out.gaps[j].label} (${jac.toFixed(2)})`);
}
const ranked = rankByScore(gaps, (g) => g.score);
const count = (n: string) => toolEvents.filter((e) => e.name === n).length;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
const summary = {
  run_id: run.run_id, provider: run.provider, status: run.status, turns: run.turns,
  spent_usd: run.spent_micro_usd / 1e6,
  tool_calls: { catalog: toolEvents.filter((e) => isCatalog(e.name)).length, web_search: count("web_search"), web_fetch: count("web_fetch"), errors: toolEvents.filter((e) => e.is_error || e.error).length },
  evidence: enriched ? "computed by code" : `${pctOf(fieldsOk, fieldsTotal)}% copied correctly`,
  comparables_valid_pct: pctOf(compOk, compTotal),
  sources_verified_pct: pctOf(srcOk, srcTotal),
  map_verified: `${mapOk}/${mapTotal}`,
  regions_opened: openedRegions.size,
  map_sourced_gaps: out.gaps.filter((g: any) => g.map?.region_id != null && openedRegions.has(g.map.region_id)).length,
  momentum_checked: `${gaps.filter((g) => g.momentum !== "unknown").length}/${gaps.length}`,
  near_duplicates: dupes,
  pass: fieldsOk === fieldsTotal && mapOk === gaps.length
    && out.gaps.filter((g: any) => g.map?.region_id != null && openedRegions.has(g.map.region_id)).length >= 2
    && gaps.every((g) => !g.issues.some((i: string) => i.includes("never opened"))) && compOk >= 0.95 * compTotal && srcOk === srcTotal && dupes.length === 0
    && gaps.filter((g) => g.momentum !== "unknown").length * 2 >= gaps.length,
};
writeFileSync(path.join(dir, "eval.json"), JSON.stringify({ summary, code_ranking: ranked.map((r) => ({ rank: r.rank, ...r.item })) }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log("\ncode rank | agent rank | score  | F    M    | momentum | gap");
for (const r of ranked) {
  const g = r.item;
  const m = g.map ? ` map novelty ${g.map.novelty_pct} region ${g.map.probe_region_id}${g.map.region_id ? ` (from r${g.map.region_id})` : ""}` : "";
  console.log(`${String(r.rank).padStart(9)} | ${String(g.agent_rank).padStart(10)} | ${g.score.toFixed(4)} | ${g.feasibility.toFixed(2)} ${g.marketability.toFixed(2)} | ${g.momentum.padEnd(8)} | ${g.label} [${g.tags.join(", ")}]${m}`);
  for (const iss of g.issues) console.log(`          ! ${iss}`);
}
