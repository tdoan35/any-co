# state-dump

Full game state as JSON, on demand, headless-safe. The harness diffs states between builds,
checks invariants (entity bounds, resource sanity), and feeds screenshots' expected values
from it.

## When
- `dump_state` command → writes `qa/state.json` (see controls.md).
- `--exit-after-ticks N` → final dump at exit, same path.
- On crash: best-effort dump with `"crashed": true` and the error in `errors[]`.

## Shape
Validated against [state.schema.json](state.schema.json). Summary:

- `schema_version`: `1`
- `scene`: current scene id (string, stable names — `"menu"`, `"run"`, `"game_over"` style)
- `tick`: simulation ticks since run start (integer)
- `run`: `{ started: bool, over: bool, seed: int, elapsed_ticks: int }`
- `player`: game-specific stats (hp, resources, position) — must include `x`, `y`
- `resources`: every counter the player can gain or spend (name → integer). Never negative;
  a negative resource here is a QA failure, not a rendering question.
- `entities[]`: every active gameplay object:
  `{ id: string, type: string, x: number, y: number, w: number, h: number }` plus optional
  game fields (`hp`, `state`, `kind`…). Coordinates are pixels, origin top-left, from the
  play-field's top-left. `id` is stable for the entity's lifetime.
- `errors[]`: non-fatal errors so far this run (`{ tick, message }`); empty in a clean run.

## Rules
- State must be complete enough that two builds given the same seed and inputs either
  produce identical dumps or the diff is a real, explainable change.
- No floats where an integer will do (positions may be floats; counts must not be).
- The dump is written atomically (temp file + rename) so the harness never reads a torn
  state.
