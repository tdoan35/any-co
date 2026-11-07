# telemetry

One summary per finished run, so "is it fun / where do players die" is answered from data,
not vibes. Written by the game at run end (also on `quit` and crash best-effort):
`qa/run_summary.json`.

## Shape

```json
{
  "schema_version": 1,
  "build_id": "20261107-1530-a1b2c3d",
  "seed": 1337,
  "policy": "greedy",
  "outcome": "loss",
  "death_cause": "enemy-slug",
  "run_ticks": 8123,
  "elapsed_s": 135.4,
  "picks": [{"tick": 900, "item": "card-shove", "choice_set": 3}],
  "counts": {"spawn": 214, "hit": 58, "death": 41, "pickup": 27},
  "peaks": {"entities": 87, "resources": {"gold": 143}}
}
```

## Rules
- `build_id` comes from the build contract (build.md) — the same id the release notes use.
- `outcome` matches the `run_end` event. `death_cause` names the actual killer entity or
  hazard, not "game over".
- `picks` records every player choice with options offered (`choice_set`) — pick rates
  come from here. If the game has no choices, `picks` is `[]`.
- `counts` are totals of the standard events (events.md); `peaks` are maxima over the run —
  QA's "entity counts bounded" invariant reads `peaks.entities`.
- `elapsed_s` is simulated seconds (`run_ticks / tick_rate`), not wall clock — telemetry
  must stay reproducible under `--time-scale`.
- The summary is atomic-write (temp + rename) and valid JSON even on a crash: write what
  you have, mark `"crashed": true`.
