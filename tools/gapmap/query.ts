// Read-side of the gap map: ranked regions, one region, probe a description, one game.
//   node --env-file=.env --import tsx tools/gapmap/query.ts regions [--limit 15] [--tag X]
//   ... region --id N | probe --text "..." | game --appid N
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DIMS, GAPMAP_DIR, USD_PER_MTOK, embed, type GameRow } from "./embed.ts";
import { type Region } from "./build.ts";
import { dot, percentileRank, prepareVectors } from "./math.ts";

interface MapFile {
  meta: { built_at: string; games: number; center: number[]; game_novelty_percentiles: number[]; window: { start: string; end: string }; baseline_traction: number } & Record<string, unknown>;
  regions: Region[];
  games: Array<{ appid: number; novelty: number; nn: number; region: number; knn?: number[]; knn_sim?: number[]; xy?: [number, number] }>;
}

let cache: { map: MapFile; games: GameRow[]; byId: Map<number, GameRow>; vectors?: Float32Array; centroids?: Float32Array } | null = null;

export function loadMap(dir = GAPMAP_DIR) {
  if (cache) return cache;
  const mapFile = path.join(dir, "map.json");
  if (!existsSync(mapFile)) throw new Error("gap map not built: run tools/gapmap/embed.ts then tools/gapmap/build.ts");
  const map = JSON.parse(readFileSync(mapFile, "utf8")) as MapFile;
  const games = readFileSync(path.join(dir, "games.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GameRow);
  cache = { map, games, byId: new Map(games.map((g) => [g.appid, g])) };
  return cache;
}

function loadF32(file: string): Float32Array {
  const raw = readFileSync(file);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

function spaces(dir = GAPMAP_DIR) {
  const c = loadMap(dir);
  if (!c.vectors) {
    c.vectors = loadF32(path.join(dir, "vectors.f32"));
    prepareVectors(c.vectors, DIMS, Float32Array.from(c.map.meta.center));
    c.centroids = loadF32(path.join(dir, "centroids.f32")); // already in the prepared space
  }
  return { V: c.vectors, C: c.centroids! };
}

export const METHOD =
  "A region is a cluster of similar Steam releases (by tags + genres + description), scored like a catalog tag over " +
  "the same window: supply = releases in the window, traction = share with 50+ reviews, demand = traction shrunk " +
  "toward the baseline, opportunity = demand_pct × (1 − supply_pct). after_window = releases since the window ended " +
  "(competition arriving now). cohesion = how tight the cluster is (low = mixed bag). indie_share = share of its games " +
  "tagged Indie: low means a AAA niche a small studio can't reach.";

/** Share of each region's members tagged Indie, computed once from games.jsonl. */
let indieShares: Map<number, number> | null = null;
export function indieShare(regionId: number): number {
  if (!indieShares) {
    const { map, games } = loadMap();
    const tot = new Map<number, number>(), ind = new Map<number, number>();
    map.games.forEach((g, i) => {
      tot.set(g.region, (tot.get(g.region) ?? 0) + 1);
      if (games[i].tags.includes("Indie")) ind.set(g.region, (ind.get(g.region) ?? 0) + 1);
    });
    indieShares = new Map([...tot].map(([r, n]) => [r, Math.round(((ind.get(r) ?? 0) / n) * 1000) / 1000]));
  }
  return indieShares.get(regionId) ?? 0;
}

const brief = (r: Region) => ({
  id: r.id, rank: r.rank, opportunity: r.window.opportunity, supply: r.window.supply, traction: r.window.traction,
  hit_rate: r.window.hit_rate, demand_pct: r.window.demand_pct, supply_pct: r.window.supply_pct,
  after_window: r.after_window, cohesion: r.cohesion, indie_share: indieShare(r.id),
  tags: r.top_tags.slice(0, 6).map((t) => t.tag),
  examples: r.top_games.slice(0, 4).map((g) => g.name),
});

export function regions(o: { limit?: number; offset?: number; tag?: string; min_supply?: number; min_cohesion?: number; min_indie_share?: number } = {}) {
  const { map } = loadMap();
  let rows = map.regions.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!);
  if (o.tag) rows = rows.filter((r) => r.top_tags.some((t) => t.tag.toLowerCase() === o.tag!.toLowerCase() && t.share >= 0.3));
  if (o.min_supply !== undefined) rows = rows.filter((r) => r.window.supply >= o.min_supply!);
  if (o.min_cohesion !== undefined) rows = rows.filter((r) => r.cohesion >= o.min_cohesion!);
  if (o.min_indie_share !== undefined) rows = rows.filter((r) => indieShare(r.id) >= o.min_indie_share!);
  const offset = o.offset ?? 0, limit = o.limit ?? 15;
  return { method: METHOD, window: map.meta.window, baseline_traction: map.meta.baseline_traction, total: rows.length, regions: rows.slice(offset, offset + limit).map(brief) };
}

export function region(id: number) {
  const { map } = loadMap();
  const r = map.regions.find((x) => x.id === id);
  if (!r) return { error: `no region ${id} (1–${map.regions.length})` };
  const { xy: _xy, adjacent, ...rest } = r;
  return {
    method: METHOD, indie_share: indieShare(r.id), ...rest,
    // Nearest regions by centroid similarity: neighboring niches, open or not.
    adjacent: (adjacent ?? []).map((a) => {
      const b = map.regions[a.id - 1];
      return { id: a.id, sim: a.sim, rank: b.rank, opportunity: b.window.opportunity ?? null, supply: b.window.supply, traction: b.window.traction, indie_share: indieShare(b.id), tags: b.top_tags.slice(0, 4).map((t) => t.tag), examples: b.top_games.slice(0, 3).map((g) => g.name) };
    }),
  };
}

/** Embed a description: nearest games, novelty vs real games, and the region it falls in. */
export async function probe(text: string, apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) throw new Error("probe needs OPENAI_API_KEY");
  const { map, games } = loadMap();
  const { V, C } = spaces();
  const { vectors: [v], tokens } = await embed([text], apiKey);
  const q = Float32Array.from(v);
  prepareVectors(q, DIMS, Float32Array.from(map.meta.center));
  const sims = new Float32Array(games.length);
  for (let i = 0; i < games.length; i++) sims[i] = dot(q, 0, V, i * DIMS, DIMS);
  const top = Array.from(sims.keys()).sort((a, b) => sims[b] - sims[a]).slice(0, 10);
  let best = 0, bestSim = -Infinity;
  for (let c = 0; c < C.length / DIMS; c++) {
    const s = dot(q, 0, C, c * DIMS, DIMS);
    if (s > bestSim) { bestSim = s; best = c; }
  }
  const reg = map.regions[best];
  const novelty = 1 - sims[top[0]];
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const xy = (() => {
    let x = 0, y = 0, w = 0;
    for (const i of top.slice(0, 8)) { const p = map.games[i].xy; if (!p) return null; x += p[0] * sims[i]; y += p[1] * sims[i]; w += sims[i]; }
    return w ? ([r4(x / w), r4(y / w)] as [number, number]) : null;
  })();
  return {
    result: {
      novelty_pct: r4(percentileRank(map.meta.game_novelty_percentiles, novelty)),
      region: brief(reg),
      note: "novelty_pct: farther from its nearest game than this share of real games are from theirs (high = nothing quite like it exists). region: the cluster it falls in, with that cluster's supply and demand. Vague text lands near generic games: describe the core loop, setting, and hook.",
      nearest: top.map((i) => ({ appid: games[i].appid, name: games[i].name, year: games[i].year, reviews: games[i].reviews, sim: r4(sims[i]), tags: games[i].tags.slice(0, 6) })),
      xy,
    },
    cost_micro_usd: Math.ceil(tokens * USD_PER_MTOK),
  };
}

export function game(appid: number) {
  const { map, byId } = loadMap();
  const g = map.games.find((x) => x.appid === appid);
  if (!g) return { error: `appid ${appid} not on the map` };
  return { ...byId.get(appid), novelty_pct: Math.round(percentileRank(map.meta.game_novelty_percentiles, g.novelty) * 1000) / 1000, nearest: byId.get(g.nn)?.name, region: g.region };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { limit: { type: "string" }, offset: { type: "string" }, tag: { type: "string" }, id: { type: "string" }, text: { type: "string" }, appid: { type: "string" }, "min-supply": { type: "string" }, "min-indie": { type: "string" } },
  });
  const cmd = positionals[0];
  const num = (s?: string) => (s === undefined ? undefined : Number(s));
  let out: unknown;
  if (cmd === "regions") out = regions({ limit: num(values.limit), offset: num(values.offset), tag: values.tag, min_supply: num(values["min-supply"]), min_indie_share: num(values["min-indie"]) });
  else if (cmd === "region") out = region(Number(values.id));
  else if (cmd === "probe") out = (await probe(values.text ?? "")).result;
  else if (cmd === "game") out = game(Number(values.appid));
  else {
    console.error('usage: query.ts regions [--limit N] [--tag X] | region --id N | probe --text "..." | game --appid N');
    process.exit(2);
  }
  console.log(JSON.stringify(out, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
