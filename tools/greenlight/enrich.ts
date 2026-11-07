// Deterministic enrichment of a Market Analyst submission: the agent supplies judgments (tags,
// thesis, comparables, scores, probe text); code adds the numbers. Nothing here is copied by an LLM.
import { runCatalog } from "../../runner/tools/impl.ts";

export async function enrichGaps(output: any): Promise<any> {
  const { probe } = await import("../gapmap/query.ts");
  const gaps = [];
  for (const g of output.gaps) {
    const niche = JSON.parse((await runCatalog(["niche", "--tags", g.tags.join(","), "--limit", "1"])).content);
    const evidence = niche.error ? { error: niche.error } : niche.window_stats;
    let map = g.map;
    if (g.map?.probe_text) {
      try {
        const p = (await probe(g.map.probe_text)).result;
        map = { ...g.map, novelty_pct: p.novelty_pct, probe_region: p.region, xy: p.xy, nearest: p.nearest.slice(0, 5).map((n: any) => n.name) };
      } catch (e: any) {
        map = { ...g.map, probe_error: String(e?.message ?? e) };
      }
    }
    gaps.push({ ...g, evidence, map });
  }
  return { ...output, gaps, enriched_by: "tools/greenlight/enrich.ts" };
}
