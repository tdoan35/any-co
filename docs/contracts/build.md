# build

Fixed targets and output paths so Build & Release, QA, and the studio window never learn
engine specifics.

## Interface
The game repo root ships a `build.sh` (bash, no arguments beyond the target) supporting:

| Target | Does | Output (must exist on success) |
|---|---|---|
| `build.sh build-web` | Web export | `dist/web/index.html` (playable, same-origin) |
| `build.sh build-windows` | Windows export | `dist/windows/<game>.exe` |
| `build.sh test` | Headless engine tests (load every scene, validate every data file) | exit 0 / non-0 |
| `build.sh qa` | One autoplay smoke run via the contracts (seed fixed inside the script) | `qa/run_summary.json` |
| `build.sh clean` | Remove build artifacts | — |

Rules:
- **Exit code is the contract**: 0 = the listed outputs exist; non-0 = failure with the
  reason on stderr. No partial-success.
- Builds are reproducible-ish: `build.sh build-web` twice without source changes produces
  byte-identical output or explains in stderr why not (engine metadata timestamps are an
  accepted difference).
- `dist/` is entirely generated: `clean` removes it; nothing in it is committed.
- `build_id`: every successful build writes `dist/build_id` — one line
  `<yyyymmdd-hhmm>-<short-git-sha>` — which the game bakes in for `run_summary.json`.

## Consumers
- Build & Release uploads `dist/web` (studio site) and `dist/windows` (Steam/itch via
  butler/steamcmd wrappers).
- QA runs `build.sh test` then `build.sh qa` before deeper checks; both must pass for a
  release candidate.
- The studio window shows the latest `build_id` and its QA status.
