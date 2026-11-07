// Build the Greenlight gap map from data/gapmap/{games.jsonl, vectors.f32}.
//   node --import tsx tools/gapmap/build.ts [--clusters 600] [--seed 42] [--no-layout]
// Writes data/gapmap/map.json (clusters, per-game novelty/cluster/xy) and centroids.f32.
// All scoring is here, in code.
//
// Method:
//  1. Embeddings (tags + genres + description, no name) are normalized, centered, renormalized.
//  2. Spherical k-means groups every real release into ~600 semantic niches ("regions").
//  3. Each region is scored exactly like a tag in tools/catalog/query.py, over the same window:
//       supply = releases in the window; traction = share with >= 50 reviews;
//       demand = traction shrunk toward the baseline (K=20); opportunity = demand_pct × (1 − supply_pct)
//     plus after_window (releases after the window: competition arriving now) and cohesion.
//  4. Game novelty = 1 − similarity to its nearest other game (for probes: "nothing like it exists").
// Tried first (Nov 6): points mixed between two hit games, then fixed-size neighborhoods. Mixes
// always landed next to a generic game, and "sparse" neighborhoods were just incoherent.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { UMAP } from "umap-js";
import { GAPMAP_DIR, DIMS, type GameRow } from "./embed.ts";
import { dot, normalizeRows, percentileRank, prepareVectors, rng } from "./math.ts";

export const K = 20; // neighbors for novelty and layout
// Same definitions as tools/catalog/query.py so tag and map numbers are comparable.
export const WINDOW = { start: "2023-06-01", end: "2025-05-31" };
const TRACTION = 50, HIT = 500, SHRINK_K = 20;
export const MIN_SUPPLY = 15;
export const EDGES_PER_GAME = 5; // saved nearest-neighbor edges per game (for the map's links)
export const EDGES_PER_REGION = 5; // saved nearest regions (by centroid similarity) // regions with fewer window releases aren't ranked
// The studio won't make adult content: clusters dominated by these tags aren't ranked.
export const EXCLUDED_TAGS = ["Sexual Content", "Nudity", "NSFW", "Hentai"];

const sharedF32 = (n: number) => {
  const buf = new SharedArrayBuffer(n * 4);
  return { buf, arr: new Float32Array(buf as unknown as ArrayBuffer) };
};
const sharedI32 = (n: number) => {
  const buf = new SharedArrayBuffer(n * 4);
  return { buf, arr: new Int32Array(buf as unknown as ArrayBuffer) };
};

/** Parallel top-k over all query rows. */
export async function knn(queries: SharedArrayBuffer, base: SharedArrayBuffer, dims: number, k: number, skipSelf: boolean) {
  const nq = queries.byteLength / 4 / dims;
  const idx = sharedI32(nq * k);
  const sim = sharedF32(nq * k);
  const workers = Math.max(1, Math.min(os.availableParallelism(), 16));
  const per = Math.ceil(nq / workers);
  await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const start = w * per, end = Math.min(nq, start + per);
      if (start >= end) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const wk = new Worker(new URL("./knn-worker.ts", import.meta.url), {
          workerData: { queries, base, dims, k, start, end, outIdx: idx.buf, outSim: sim.buf, skipSelf },
        });
        wk.once("message", () => resolve());
        wk.once("error", reject);
      });
    }),
  );
  return { idx: idx.arr, sim: sim.arr };
}

/** Spherical k-means (cosine). k-means++ init on a sample; empty clusters are reseeded. */
export async function kmeans(B: Float32Array, n: number, k: number, opts: { seed: number; iters?: number; log?: (s: string) => void }) {
  const rand = rng(opts.seed);
  const cent = sharedF32(k * DIMS);
  const C = cent.arr;
  // k-means++ on up to 20k sampled rows
  const sample = Array.from({ length: Math.min(n, 20000) }, () => Math.floor(rand() * n));
  const d2 = new Float32Array(sample.length).fill(Infinity);
  let pick = sample[0];
  for (let c = 0; c < k; c++) {
    C.set(B.subarray(pick * DIMS, pick * DIMS + DIMS), c * DIMS);
    let total = 0;
    for (let i = 0; i < sample.length; i++) {
      const d = 1 - dot(B, sample[i] * DIMS, C, c * DIMS, DIMS);
      if (d < d2[i]) d2[i] = d;
      total += d2[i] * d2[i];
    }
    let r = rand() * total;
    for (let i = 0; i < sample.length; i++) {
      r -= d2[i] * d2[i];
      if (r <= 0) { pick = sample[i]; break; }
    }
  }
  const qbuf = new SharedArrayBuffer(n * DIMS * 4);
  new Float32Array(qbuf as unknown as ArrayBuffer).set(B.subarray(0, n * DIMS));
  let assign = new Int32Array(n);
  for (let it = 0; it < (opts.iters ?? 25); it++) {
    const { idx, sim } = await knn(qbuf, cent.buf, DIMS, 1, false);
    let changed = 0;
    for (let i = 0; i < n; i++) if (idx[i] !== assign[i]) changed++;
    assign = Int32Array.from(idx);
    const sums = new Float64Array(k * DIMS);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let d = 0; d < DIMS; d++) sums[c * DIMS + d] += B[i * DIMS + d];
    }
    // Reseed empty clusters with the worst-fit points.
    const worst = Array.from({ length: n }, (_, i) => i).sort((a, b) => sim[a] - sim[b]);
    let w = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        const p = worst[w++];
        for (let d = 0; d < DIMS; d++) C[c * DIMS + d] = B[p * DIMS + d];
      } else {
        for (let d = 0; d < DIMS; d++) C[c * DIMS + d] = sums[c * DIMS + d];
      }
    }
    normalizeRows(C, DIMS);
    opts.log?.(`kmeans iter ${it + 1}: ${changed} reassigned`);
    if (it > 0 && changed < n * 0.002) break;
  }
  return { assign, centroids: C };
}

export interface RegionStats {
  supply: number;
  traction: number;
  hit_rate: number;
  demand: number;
  median_reviews: number;
  median_price_paid: number | null;
  demand_pct?: number;
  supply_pct?: number;
  opportunity?: number;
}

export interface Region {
  id: number; // cluster id (stable within a build)
  rank: number | null; // by opportunity among eligible regions; null if not ranked
  size: number; // all releases in the cluster
  window: RegionStats; // releases in WINDOW
  after_window: number; // releases after WINDOW.end: competition arriving now
  cohesion: number; // mean similarity of members to the centroid
  top_tags: Array<{ tag: string; share: number }>;
  top_games: Array<{ appid: number; name: string; year: number | null; reviews: number }>;
  recent_games: Array<{ appid: number; name: string; date: string | null; reviews: number }>;
  excluded?: string;
  adjacent: Array<{ id: number; sim: number }>; // nearest regions by centroid similarity
  xy?: [number, number];
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function windowStats(members: GameRow[], baseline: number): RegionStats {
  const w = members.filter((g) => g.date && g.date >= WINDOW.start && g.date <= WINDOW.end);
  const n = w.length;
  const hits = w.filter((g) => g.reviews >= TRACTION).length;
  const paid = w.map((g) => g.price).filter((p) => p > 0);
  return {
    supply: n,
    traction: n ? r4(hits / n) : 0,
    hit_rate: n ? r4(w.filter((g) => g.reviews >= HIT).length / n) : 0,
    demand: r4((hits + SHRINK_K * baseline) / (n + SHRINK_K)),
    median_reviews: median(w.map((g) => g.reviews)),
    median_price_paid: paid.length ? Math.round(median(paid) * 100) / 100 : null,
  };
}

export async function buildMap(games: GameRow[], vectors: Float32Array, opts: { clusters: number; seed: number; layout: boolean; log?: (s: string) => void }) {
  const log = opts.log ?? (() => {});
  const n = games.length;
  const base = sharedF32(n * DIMS);
  base.arr.set(vectors);
  const mean = prepareVectors(base.arr, DIMS);
  const B = base.arr;

  let t = Date.now();
  const nn = await knn(base.buf, base.buf, DIMS, K, true);
  log(`game kNN: ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const novelty = new Float32Array(n);
  for (let i = 0; i < n; i++) novelty[i] = 1 - nn.sim[i * K];
  const sortedNovelty = Float32Array.from(novelty).sort();

  t = Date.now();
  const k = Math.min(opts.clusters, n);
  const { assign, centroids } = await kmeans(B, n, k, { seed: opts.seed, log });
  log(`kmeans (${k}): ${((Date.now() - t) / 1000).toFixed(1)}s`);

  const inWindow = games.filter((g) => g.date && g.date >= WINDOW.start && g.date <= WINDOW.end);
  const baseline = inWindow.length ? inWindow.filter((g) => g.reviews >= TRACTION).length / inWindow.length : 0;
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[assign[i]].push(i);

  const regions: Region[] = members.map((m, c) => {
    const rows = m.map((i) => games[i]);
    const tagCount = new Map<string, number>();
    for (const g of rows) for (const tg of g.tags) tagCount.set(tg, (tagCount.get(tg) ?? 0) + 1);
    const tagged = rows.filter((g) => g.tags.length).length || 1;
    const top_tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, cnt]) => ({ tag, share: r4(cnt / tagged) }));
    const adult = top_tags.filter((x) => EXCLUDED_TAGS.includes(x.tag) && x.share >= 0.3).map((x) => x.tag);
    let coh = 0;
    for (const i of m) coh += dot(B, i * DIMS, centroids, c * DIMS, DIMS);
    const stats = windowStats(rows, baseline);
    return {
      id: c + 1,
      rank: null,
      size: m.length,
      window: stats,
      after_window: rows.filter((g) => g.date && g.date > WINDOW.end).length,
      cohesion: r4(m.length ? coh / m.length : 0),
      top_tags,
      top_games: [...rows].sort((a, b) => b.reviews - a.reviews).slice(0, 8).map((g) => ({ appid: g.appid, name: g.name, year: g.year, reviews: g.reviews })),
      recent_games: rows.filter((g) => g.date && g.date >= WINDOW.start).sort((a, b) => b.reviews - a.reviews).slice(0, 6)
        .map((g) => ({ appid: g.appid, name: g.name, date: g.date, reviews: g.reviews })),
      adjacent: [],
      ...(adult.length ? { excluded: `adult content (${adult.join(", ")})` } : stats.supply < MIN_SUPPLY ? { excluded: `supply < ${MIN_SUPPLY} in window` } : {}),
    };
  });

  // Region adjacency: nearest centroids (k × k dot products; k ≈ 600).
  for (let a = 0; a < k; a++) {
    const sims: Array<{ id: number; sim: number }> = [];
    for (let b = 0; b < k; b++) if (a !== b && members[b].length) sims.push({ id: b + 1, sim: r4(dot(centroids, a * DIMS, centroids, b * DIMS, DIMS)) });
    regions[a].adjacent = sims.sort((x, y) => y.sim - x.sim).slice(0, EDGES_PER_REGION);
  }

  const eligible = regions.filter((r) => !r.excluded);
  const demands = eligible.map((r) => r.window.demand).sort((a, b) => a - b);
  const supplies = eligible.map((r) => r.window.supply).sort((a, b) => a - b);
  for (const r of eligible) {
    r.window.demand_pct = r4(percentileRank(demands, r.window.demand));
    r.window.supply_pct = r4(percentileRank(supplies, r.window.supply));
    r.window.opportunity = r4(r.window.demand_pct * (1 - r.window.supply_pct));
  }
  eligible.sort((a, b) => b.window.opportunity! - a.window.opportunity! || b.window.demand - a.window.demand);
  eligible.forEach((r, i) => (r.rank = i + 1));

  let layout: Array<[number, number]> | null = null;
  if (opts.layout) {
    t = Date.now();
    const knnIdx: number[][] = [], knnDist: number[][] = [];
    for (let i = 0; i < n; i++) {
      knnIdx.push([i, ...Array.from(nn.idx.subarray(i * K, i * K + K - 1))]);
      knnDist.push([0, ...Array.from(nn.sim.subarray(i * K, i * K + K - 1), (s) => Math.max(0, 1 - s))]);
    }
    const umap = new UMAP({ nComponents: 2, nNeighbors: K, minDist: 0.15, random: rng(opts.seed) });
    umap.setPrecomputedKNN(knnIdx, knnDist);
    const epochs = umap.initializeFit(Array.from({ length: n }, (_, i) => [i])); // data unused with precomputed kNN
    for (let e = 0; e < epochs; e++) umap.step();
    layout = umap.getEmbedding().map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
    log(`layout (${epochs} epochs): ${((Date.now() - t) / 1000).toFixed(1)}s`);
    // Region position: median member position (robust to stray members).
    for (const r of regions) {
      const pts = members[r.id - 1].map((i) => layout![i]);
      if (pts.length) r.xy = [median(pts.map((p) => p[0])), median(pts.map((p) => p[1]))];
    }
  }

  const gameRows = games.map((g, i) => ({
    appid: g.appid, novelty: r4(novelty[i]), nn: games[nn.idx[i * K]].appid, region: assign[i] + 1,
    knn: Array.from(nn.idx.subarray(i * K, i * K + EDGES_PER_GAME)), // row indices into games.jsonl
    knn_sim: Array.from(nn.sim.subarray(i * K, i * K + EDGES_PER_GAME), (s) => Math.round(s * 1000) / 1000),
    ...(layout ? { xy: layout[i] } : {}),
  }));
  return { regions, games: gameRows, sortedNovelty, centroids, mean, baseline };
}

function loadInputs() {
  const gamesFile = path.join(GAPMAP_DIR, "games.jsonl");
  const vecFile = path.join(GAPMAP_DIR, "vectors.f32");
  if (!existsSync(gamesFile) || !existsSync(vecFile)) throw new Error("run tools/gapmap/embed.ts first");
  const games = readFileSync(gamesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GameRow);
  const raw = readFileSync(vecFile);
  const vectors = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (vectors.length !== games.length * DIMS) throw new Error(`vectors (${vectors.length / DIMS}) and games (${games.length}) differ; re-run embed.ts`);
  return { games, vectors };
}

export const sample101 = (a: Float32Array) =>
  Array.from({ length: 101 }, (_, i) => r4(a[Math.min(a.length - 1, Math.floor((i / 100) * (a.length - 1)))]));

async function main() {
  const { values } = parseArgs({ options: { clusters: { type: "string", default: "600" }, seed: { type: "string", default: "42" }, "no-layout": { type: "boolean", default: false } } });
  const { games, vectors } = loadInputs();
  console.log(`games: ${games.length}`);
  const t0 = Date.now();
  const out = await buildMap(games, vectors, { clusters: Number(values.clusters), seed: Number(values.seed), layout: !values["no-layout"], log: (s) => console.log("  " + s) });
  writeFileSync(path.join(GAPMAP_DIR, "centroids.f32"), Buffer.from(out.centroids.buffer.slice(0)));
  writeFileSync(
    path.join(GAPMAP_DIR, "map.json"),
    JSON.stringify({
      meta: {
        built_at: new Date().toISOString(), games: games.length, clusters: out.regions.length, seed: Number(values.seed),
        window: WINDOW, baseline_traction: r4(out.baseline), min_supply: MIN_SUPPLY,
        method: "spherical k-means over centered embeddings (tags+genres+description); each region scored like a catalog tag: opportunity = demand_pct × (1 − supply_pct) over the window; see tools/gapmap/build.ts",
        game_novelty_percentiles: sample101(out.sortedNovelty),
        excluded_tags: EXCLUDED_TAGS,
        center: Array.from(out.mean, (x) => Math.round(x * 1e6) / 1e6),
      },
      regions: out.regions,
      games: out.games,
    }),
  );
  console.log(`wrote data/gapmap/map.json: ${out.regions.filter((r) => r.rank).length} ranked of ${out.regions.length} regions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
