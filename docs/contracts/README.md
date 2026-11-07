# Contracts

Interfaces every studio game must implement. Harness tools (QA, art gate, trailer capture,
release) are built against these, never against a specific game. The studio's Tech Lead
implements them in the game skeleton in hour one; the game fails the QA gate if any
contract is missing.

## Golden rules
- **Deterministic given a seed.** Same seed + same inputs (including autoplay policy) =
  same state at every tick. No wall-clock, no RNG outside the seeded stream, no iteration
  over unordered sets in anything that writes state.
- **JSON only, UTF-8, one file per concern.** All paths are relative to the game repo
  root unless the contract says otherwise. The `qa/` directory is the harness's; the game
  never writes anywhere else while `--qa` is set.
- **The desktop build implements the harness surface.** Web builds ignore QA flags.
- **`schema_version` on every payload** (currently `1`). A harness tool that doesn't
  understand the version fails loudly instead of guessing.

## The surface

| Contract | File | What the harness gets |
|---|---|---|
| controls | [controls.md](controls.md) | Launch flags + the `qa/` command protocol: pause, step, quit |
| state-dump | [state-dump.md](state-dump.md) + [state.schema.json](state.schema.json) | Full game state as JSON on demand |
| autoplay | [autoplay.md](autoplay.md) | Bot-driven play with pluggable input policies |
| screenshot | [screenshot.md](screenshot.md) | PNG capture usable headless |
| events | [events.md](events.md) | JSONL stream at hook points (spawn, hit, death, …) |
| asset-manifest | [asset-manifest.md](asset-manifest.md) + [asset.schema.json](asset.schema.json) | Every asset with type, size, palette, frames, anchor |
| telemetry | [telemetry.md](telemetry.md) | `run_summary.json` per run: length, death cause, picks |
| build | [build.md](build.md) | Fixed build targets and output paths for web + Windows |

## How the pieces meet
QA launches the desktop build with `--qa --autoplay --seed N --time-scale 10`, drives it
through `qa/control.json`, reads `qa/events.jsonl` and state dumps, and captures
screenshots on event triggers. The trailer tool uses the same surface with a scripted
policy. The art gate reads the asset manifest and never loads the game.
