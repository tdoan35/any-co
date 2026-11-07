import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMS, embedText, type GameRow } from "./embed.ts";
import { buildMap, knn } from "./build.ts";
import { dot, normalizeRows, percentileRank, rng, topK } from "./math.ts";

const rand = rng(7);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function cluster(center: Float32Array, n: number, spread: number): Float32Array[] {
  return Array.from({ length: n }, () => Float32Array.from(center, (c) => c + gauss() * spread));
}

test("topK matches brute force and skips self", () => {
  const n = 60, d = 16, k = 5;
  const m = normalizeRows(Float32Array.from({ length: n * d }, gauss), d);
  const idx = new Int32Array(n * k), sim = new Float32Array(n * k);
  topK(m, m, d, k, 0, n, idx, sim, true);
  for (let q = 0; q < n; q++) {
    const brute = Array.from({ length: n }, (_, b) => ({ b, s: b === q ? -Infinity : dot(m, q * d, m, b * d, d) }))
      .sort((x, y) => y.s - x.s).slice(0, k).map((x) => x.b);
    assert.deepEqual(Array.from(idx.subarray(q * k, q * k + k)), brute);
    assert.ok(!idx.subarray(q * k, q * k + k).includes(q));
  }
});

test("parallel knn equals single-thread topK", async () => {
  const n = 300, k = 4;
  const buf = new SharedArrayBuffer(n * DIMS * 4);
  const m = new Float32Array(buf as unknown as ArrayBuffer);
  m.set(normalizeRows(Float32Array.from({ length: n * DIMS }, gauss), DIMS));
  const par = await knn(buf, buf, DIMS, k, true);
  const idx = new Int32Array(n * k), sim = new Float32Array(n * k);
  topK(m, m, DIMS, k, 0, n, idx, sim, true);
  assert.deepEqual(Array.from(par.idx), Array.from(idx));
});

test("percentiles and seeded rng are deterministic", () => {
  assert.equal(percentileRank([1, 2, 3, 4], 3), 0.625);
  assert.equal(percentileRank([1, 2, 3, 4], 10), 1);
  assert.equal(percentileRank([1, 1, 1, 1], 1), 0.5); // ties share the midrank
  assert.equal(percentileRank([1, 2, 3, 4], 0), 0);
  const a = rng(1), b = rng(1);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("embed text includes tags, genres, and cleaned description", () => {
  const t = embedText(["A", "B"], ["Indie"], "<p>Hello&nbsp;<b>world</b></p>");
  assert.equal(t, "Tags: A, B. Genres: Indie. Hello world");
});

test("clusters are scored like tags: few releases + high traction ranks first; adult clusters excluded", async () => {
  // Four well-separated niches, all released in the analysis window:
  //   A: 60 releases, 30% traction   B: 20 releases, 80% traction (the gap)
  //   C: 60 releases, 5% traction    D: adult-tagged, 90% traction (never ranked)
  const axis = (i: number) => Float32Array.from({ length: DIMS }, (_, d) => (d === i ? 1 : 0));
  const spec: Array<[string, number, number, string[]]> = [["A", 60, 0.3, ["A"]], ["B", 20, 0.8, ["B"]], ["C", 60, 0.05, ["C"]], ["D", 20, 0.9, ["Nudity"]]];
  const games: GameRow[] = [];
  const vecs: number[] = [];
  spec.forEach(([label, n, rate, tags], gi) => {
    cluster(axis(gi), n, 0.01).forEach((v, j) => {
      const reviews = j < Math.round(n * rate) ? 600 : 5;
      games.push({ appid: games.length + 1, name: `${label}-${j}`, date: "2024-03-01", year: 2024, reviews, traction: reviews >= 50, price: 5, tags });
      vecs.push(...v);
    });
  });
  const out = await buildMap(games, Float32Array.from(vecs), { clusters: 4, seed: 3, layout: false });
  const ranked = out.regions.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const label = (r: (typeof ranked)[number]) => r.top_games[0].name.split("-")[0];
  assert.equal(label(ranked[0]), "B");
  assert.ok(!ranked.some((r) => label(r) === "D"), "adult cluster is not ranked");
  assert.match(out.regions.find((r) => r.top_games[0].name.startsWith("D"))!.excluded!, /adult/);
  const b = ranked[0].window;
  assert.equal(b.supply, 20);
  assert.equal(b.traction, 0.8);
  assert.ok(out.regions.every((r) => r.cohesion > 0.9), "tight synthetic clusters are cohesive");
});
