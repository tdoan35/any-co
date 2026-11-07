# tools/qa — QA contract driver and invariant checks

Harness side of `docs/contracts/` (layers 1–2 of the QA gate, plan §6). Drives any game that
implements the contracts; knows nothing about the game itself.

## CLI (`npm run qa -- ...`)

    qa smoke --cmd '<json argv>' --dir <game dir> --seed N --ticks N [--policy ID]
             [--step-frames N] [--max-entities N] [--identical-dumps N] [--tick-rate N]
             [--ack-timeout-ms N] [--ready-timeout-ms N] [--end-wait-ms N]
    qa check --dir <qa dir> [--max-entities N] [--identical-dumps N] [--tick-rate N]
    qa determinism --cmd '<json argv>' --dir <game dir> --seed N --ticks N [as smoke]

- `smoke` — clears stale `qa/` outputs, launches `--cmd` (argv array, never a shell string) in
  `--dir` with the contract flags (`--qa --seed --autoplay --policy? --exit-after-ticks`), waits
  for the ready ack `{id:0,ready:true}` (controls.md), then drives `pause` → (`step N` +
  `dump_state`)* → `resume`, and waits bounded (`--end-wait-ms`, default ack×2+60s) for the
  natural end; on timeout `quit`, then SIGTERM→SIGKILL. A command that loses the race to a
  natural end (the game exits right after `run_end` + `run_summary`) is a clean end, not an
  error; a protocol failure on a live process is a harness error (exit 2).
- `check` — offline invariants over `qa/state.json`, `qa/events.jsonl`, `qa/run_summary.json`
  already in `--dir`. Only the final dump survives a run, so softlock data comes from `smoke`.
- `determinism` — two full runs (each with cleared `qa/`), same seed/policy; both must end
  cleanly and the final state dumps must be identical (first differing path reported).

Exit codes: `0` pass, `1` invariant failure — including an unclean process end, which is its
own `process_exit_clean` check —, `2` harness/usage error (ready/ack timeout on a live
process, spawn failure, unreadable files). JSON on stdout
`{ ok, exitCode, checks[], error?, end? }`; every check carries numbers in `detail`.

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
(`telemetry_counts_standard_only`) · `elapsed_s` ≈ `run_ticks / --tick-rate` · final tick ==
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
