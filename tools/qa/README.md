# tools/qa — QA contract driver and invariant checks

Harness side of `docs/contracts/` (layers 1–2 of the QA gate, plan §6). Drives any game that
implements the contracts; knows nothing about the game itself.

## CLI (`npm run qa -- ...`)

    qa smoke --cmd '<json argv>' --dir <game dir> --seed N --ticks N [--policy ID]
             [--step-frames N] [--max-entities N] [--identical-dumps N] [--tick-rate N]
             [--ack-timeout-ms N] [--ready-timeout-ms N] [--end-wait-ms N]
    qa check --dir <qa dir> [--max-entities N] [--identical-dumps N] [--tick-rate N]
    qa determinism --cmd '<json argv>' --dir <game dir> --seed N --ticks N [as smoke]
    qa ui-lint --dir <qa dir> [--viewport WxH] [--min-text-px N] [--grid-px N]
    qa export-check --dir <game dir> [--dist <dir>/dist] [--frames 90] [--timeout-ms N] [--run true|false] [--save-frames N --save-dir <dir>]

- `smoke` — clears stale `qa/` outputs, launches `--cmd` (argv array, never a shell string) in
  `--dir` with the contract flags (`--qa --seed --autoplay --policy? --exit-after-ticks`), waits
  for the ready ack `{id:0,ready:true}` (controls.md), then drives `pause` → anchor
  `dump_state` → first `step (stepFrames - tick % stepFrames)` so every later boundary is a
  multiple of the step grid regardless of when the pause landed (R8b F1) → (`step` +
  `dump_state`)* → `resume`, and waits bounded (`--end-wait-ms`, default ack×2+60s) for the
  natural end; on timeout `quit`, then SIGTERM→SIGKILL. A command that loses the race to a
  natural end (the game exits right after `run_end` + `run_summary`) is a clean end, not an
  error; a protocol failure on a live process is a harness error (exit 2).
- `check` — offline invariants over `qa/state.json`, `qa/events.jsonl`, `qa/run_summary.json`
  already in `--dir`. Only the final dump survives a run, so softlock data comes from `smoke`.
- `determinism` — two full runs (each with cleared `qa/`), same seed/policy; both must end
  cleanly and the final state dumps must be identical (first differing path reported).
- `export-check` (`export.ts`, the release gate on what ships, T26). It checks
  `dist/web/index.pck` and any `dist/windows/*.pck`. (1) Pack table: parse the .pck directory
  (format 1–4, refused if encrypted) and require every `project.godot` `[autoload]` script as `.gd`,
  `.gdc` or `.remap`. A `strings` scan would be fooled, because exported scenes still reference
  `res://src/…` when the scripts are left out. (2) Native run: `godot --main-pack <pck>` from an
  empty temp dir (no project.godot, so only the pack loads) in movie mode (`--write-movie`,
  `--fixed-fps 30`, `--quit-after N`; it opens a window, since plain `--headless` doesn't render
  here). Fails on a non-zero exit, zero frames, or engine load-failure lines. The LAST frame must
  have ≥ 5% non-background pixels (background = most common colour) on the whole frame AND the
  central half, and ≥ 8 colours. Why movie mode, not the screenshot command: the qa/ capture
  scenes are excluded from exports, so the shipped pack can't answer `screenshot`. The movie
  writer is the engine's own capture of the frame a player sees. Every project-dir layer can
  pass on a pack that ships without its scripts; this one can't. `--save-frames N --save-dir D`
  (capability: `save_frames`, into `media/export-frames/<pack>/` in the workspace) copies N evenly
  spaced frames, always including the last, for UI review with image_view (T33).

Exit codes: `0` pass, `1` invariant failure — including an unclean process end, which is its
own `process_exit_clean` check —, `2` harness/usage error (ready/ack timeout on a live
process, spawn failure, unreadable files). JSON on stdout
`{ ok, exitCode, checks[], error?, end? }`; every check carries numbers in `detail`.

## UI lint (`ui-lint.ts`, pure; `qa ui-lint`, `qa_ui_lint` via qa_harness)

Release-gate layer **when the game emits `ui[]`** (state-dump.md): over every dump's ui[] —
(a) overlaps between visible non-overlay elements (intersection area > 0; parent/contains
relations exempt, transitively), (b) rects outside the viewport (`--viewport`, default
1280x720), (c) `text_px` below `--min-text-px` (default 10), (d) optional `--grid-px` snap on
x/y. Findings: `{ check, ids, rect(s), tick, detail }`. No `ui[]` in any dump ⇒
`ui_lint_not_implemented` — reported, never counted as a pass. Malformed entries are skipped.

## Invariants (`invariants.ts`, pure)

`schema_version` on **every** payload (dumps, events, run_summary) · every state dump valid
against `state.schema.json` (built-in validator for exactly that schema's keywords; throws on
unknown keywords so a schema change can't silently weaken the check; `required`/
`additionalProperties` apply to objects with or without `properties`) · standard events carry
their required `data` keys · no `error` events / empty `errors[]` / not `crashed` · exactly one
`run_end`, outcome win|loss|quit == `run_summary.outcome`, `run.over` · no softlock: while
running, ticks strictly increase between dumps and the tick-less state repeats ≤
`--identical-dumps` times · `peaks.entities` ≤ limit · no negative resource ·
`run_summary.counts` equals per-name event tallies; non-standard keys in `counts` are flagged
(`telemetry_counts_standard_only`) · `elapsed_s` ≈ `run_ticks / --tick-rate` (per game — the
contract fixes only the shape; the stub runs 60 Hz, caravan-cargo-cult's sim 4 Hz) · final tick ==
`run_ticks` · determinism via `firstDifference`.

## Library

- `driver.ts` — `launch({ cmd, cwd, seed, clean? })` → `waitReady`, `send` (id-matched ack,
  timeout, rejects when the process ends), `events`, `readState`, `readRunSummary`, `done`
  (exit/signal/timeout + stderr tail), `hasEnded`, `kill(graceMs)` = SIGTERM then SIGKILL.
  `cleanQaOutputs` removes the previous run's files; all harness writes atomic.
- `invariants.ts` — `runInvariants(files, opts)`; `STANDARD_EVENTS`; `validateValue`;
  `firstDifference`.

## Tests

`qa.test.ts` + `test/emulator.mjs` — a contract-faithful fake game (test double, not a game):
startup handshake and output clearing, ack only after a command finishes, `state.json` only on
`dump_state`/end/crash, run ends by itself at `--exit-after-ticks`. Modes
`happy slow-start crash-mid exit-nonzero negative-resource float-resource softlock
flaky-summary nondeterministic slow-ack ignore-sigterm` cover D1–D10; each driver fix has a
regression that fails on the pre-fix behavior. Temp dirs only.
