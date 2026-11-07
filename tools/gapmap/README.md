# tools/gapmap

The Greenlight gap map: every real Steam game with 10+ reviews (~56.6k) embedded from its name,
tags, genres, and description, then searched for open space next to proven demand.

```
node --env-file=.env --import tsx tools/gapmap/embed.ts     # ~$0.25, resumable; data/gapmap/{games.jsonl,vectors.f32}
node --import tsx tools/gapmap/build.ts                     # kNN + regions + 2D layout → data/gapmap/map.json
node --import tsx tools/gapmap/render.ts [--run runs/<id>]  # → data/gapmap/map.html (overlay a run's gaps; eval it first)
node --env-file=.env --import tsx tools/gapmap/query.ts regions | region --id N | probe --text "..." | game --appid N
```

## Method (all in code)
1. **Embed:** `text-embedding-3-small` at 256 dims.
2. **Game novelty:** 1 − cosine similarity to the nearest other game.
3. **Candidates:** 40k normalized mixes of two successful games (50+ reviews) that are related but
   not similar (similarity 0.2–0.6), with a mix weight of 0.35–0.65. Points "between" proven things.
4. **Score:** `novelty_pct × demand_pct`.
   - `novelty_pct`: the candidate's distance to its nearest game, ranked against real games'
     own nearest-neighbor distances ("farther from anything than X% of real games").
   - `demand_pct`: the similarity-weighted share of its 20 nearest games with 50+ reviews,
     ranked against all candidates. Ties share the midrank.
5. **Regions:** greedy top 300, deduplicated at similarity 0.9.
6. **Layout:** UMAP on the precomputed game kNN.

Novelty alone would favor empty space nobody wants, so demand is part of the score. Coherence
(whether a region's neighbors share an audience) and feasibility are left to the agents.

Agent tools (capability `gap_map`): `gapmap_regions`, `gapmap_region`, `gapmap_probe`.
Tests: `tools/gapmap/gapmap.test.ts` (kNN vs brute force, percentiles, a synthetic map).
