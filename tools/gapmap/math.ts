// Vector math for the gap map. Plain typed arrays, no dependencies, deterministic.

/** L2-normalize each row of an N×D matrix in place. */
export function normalizeRows(m: Float32Array, dims: number): Float32Array {
  for (let r = 0; r < m.length / dims; r++) {
    const o = r * dims;
    let s = 0;
    for (let d = 0; d < dims; d++) s += m[o + d] * m[o + d];
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dims; d++) m[o + d] *= inv;
  }
  return m;
}

/** Subtract the column mean from every row (in place) and return the mean. Reduces "hubness":
 *  generic items sitting near everything because all embeddings share a common direction. */
export function centerRows(m: Float32Array, dims: number, mean?: Float32Array): Float32Array {
  const n = m.length / dims;
  const mu = mean ?? new Float32Array(dims);
  if (!mean) {
    for (let r = 0; r < n; r++) for (let d = 0; d < dims; d++) mu[d] += m[r * dims + d];
    for (let d = 0; d < dims; d++) mu[d] /= n || 1;
  }
  for (let r = 0; r < n; r++) for (let d = 0; d < dims; d++) m[r * dims + d] -= mu[d];
  return mu;
}

/** normalize → center → normalize: the space every gap map distance is measured in. */
export function prepareVectors(m: Float32Array, dims: number, mean?: Float32Array): Float32Array {
  normalizeRows(m, dims);
  const mu = centerRows(m, dims, mean);
  normalizeRows(m, dims);
  return mu;
}

export function dot(a: Float32Array, ao: number, b: Float32Array, bo: number, dims: number): number {
  let s = 0;
  for (let d = 0; d < dims; d++) s += a[ao + d] * b[bo + d];
  return s;
}

/**
 * Top-k most similar base rows (cosine, rows pre-normalized) for query rows [start, end).
 * Writes indices and similarities into out arrays at query position q*k. With skipSelf, a query
 * row is not matched to the base row with the same index (query === base for game-vs-game).
 */
export function topK(
  queries: Float32Array, base: Float32Array, dims: number, k: number,
  start: number, end: number, outIdx: Int32Array, outSim: Float32Array, skipSelf: boolean,
): void {
  const n = base.length / dims;
  const idx = new Int32Array(k);
  const sim = new Float32Array(k);
  for (let q = start; q < end; q++) {
    idx.fill(-1);
    sim.fill(-Infinity);
    const qo = q * dims;
    let floor = -Infinity; // similarity of the current k-th best
    for (let b = 0; b < n; b++) {
      if (skipSelf && b === q) continue;
      const s = dot(queries, qo, base, b * dims, dims);
      if (s <= floor) continue;
      let j = k - 1; // insertion into the sorted (desc) top-k list
      while (j > 0 && sim[j - 1] < s) {
        sim[j] = sim[j - 1];
        idx[j] = idx[j - 1];
        j--;
      }
      sim[j] = s;
      idx[j] = b;
      floor = sim[k - 1];
    }
    outIdx.set(idx, q * k);
    outSim.set(sim, q * k);
  }
}

function bound(sorted: Float32Array | number[], v: number, strict: boolean): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] < v : sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Midrank percentile of v in sorted values: ties share the average rank, so all-equal → 0.5. */
export function percentileRank(sorted: Float32Array | number[], v: number): number {
  if (!sorted.length) return 0;
  return (bound(sorted, v, true) + bound(sorted, v, false)) / 2 / sorted.length;
}

/** Small seeded PRNG (mulberry32) so builds are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
