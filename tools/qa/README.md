# tools/qa — QA contract driver and invariant checks

Harness side of `docs/contracts/` (layers 1–2 of the QA gate, plan §6). Drives any game that
implements the contracts; knows nothing about the game itself.

## CLI (`npm run qa -- ...`)

    qa smoke --cmd '<json argv>' --dir <game dir> --seed N --ticks N [--policy ID]
             [--max-entities N] [--identical-dumps N] [--ack-timeout-ms N] [--end-wait-ms N]
    qa check --dir <qa dir> [--max-entities N] [--identical-dumps N]
    qa determinism --cmd '<json argv>' --dir <game dir> --seed N --ticks N

- `smoke` — launches `--cmd` (argv array, never a shell string) in `--dir` with the contract
  flags (`--qa --seed --autoplay --time-scale? --policy? --exit-after-ticks`), drives it through
  `qa/control.json` (pause → step 5 ×ticks/5, snapshot after each → resume), waits bounded for
  exit (`--end-wait-ms`, default ack×2+60s), else `quit` then kill, and runs every invariant.
  A command failure on a live process is a harness error; a failure caused by the process
  ending (crash mid-run) is reported and the invariants decide.
- `check` — offline: runs the invariants over `qa/state.json`, `qa/events.jsonl`,
  `qa/run_summary.json` already in `--dir`.
- `determinism` — two full runs, same seed/policy; diffs the final state dumps and reports the
  first differing path.

Exit codes: `0` pass, `1` invariant failure, `2` harness/usage error. JSON result on stdout
(`{ ok, exitCode, checks[], error?, end? }`); every check carries numbers in `detail`.

## Invariants (`invariants.ts`, pure functions)

`schema_version` known · state valid against `state.schema.json` (small built-in validator for
exactly the features that schema uses) · no `error` events / empty `errors[]` / not `crashed` ·
run completes (`run_end` once, outcome win|loss|quit, matches `run_summary.outcome`, `run.over`)
· no softlock (ticks monotonic; ≤ `--identical-dumps` consecutive identical dumps while the run
is not over) · `peaks.entities` ≤ limit · no negative resource · `run_summary.counts` equal
standard-event tallies · `elapsed_s` consistent with `run_ticks` (60 Hz sim) · final tick equals
`run_ticks` · determinism via `firstDifference` (reports `$.a.b[3]: 1 vs 2` style paths).

## Library

- `driver.ts` — `launch({ cmd, cwd, seed, ... })` → `send` (id-matched ack, timeout), `events`,
  `readState`, `readRunSummary`, `done` (exit code / signal / timeout, stderr tail), `hasEnded`,
  `kill`. `flagArgs` builds the contract flags; ids increase per `controls.md`.
- `invariants.ts` — `runInvariants(files, opts)` over `{ states[], finalState, events[], runSummary }`;
  `validateValue` (schema subset), `firstDifference`.

## Tests

`qa.test.ts` + `test/emulator.mjs` — a fake contract emulator (test double, not a game): modes
`happy | crash-mid | negative-resource | softlock | flaky-summary | nondeterministic | slow-ack`
cover the happy path, ack timeout, crash mid-run, injected negative resource, injected softlock,
telemetry mismatch, and a system-RNG nondeterminism caught by `determinism`. Temp dirs only.
