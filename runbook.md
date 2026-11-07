# Runbook

For overnight operations. Fill in as the harness takes shape.

## Start the studio
`npm run studio` — the dispatcher polls the studio board and runs local agents on due cards:
one card per agent at a time, `blocked_by` for order, `--max-parallel N` (default 2),
`--poll-s S` (default 10), `--once` for a single pass (cron), `--approve-all` to pass the ask-gate.
Board backend: `STUDIO_BOARD=local` (default; `runs/board.jsonl`, override `STUDIO_BOARD_FILE`) or
`STUDIO_BOARD=naive` (needs `NAIVE_API_KEY` + `STUDIO_BOARD_REF` = the Studio Head agent's `brd_`/`agt_`
id). Cards come from the Studio Head (`board_create`) or by hand; done notes carry run id and spend.
Restart-safe: on startup a `doing` card with no live run is requeued to `todo` with a comment.
## Check health (what "fine" looks like)
## Restart the local runner
## Cut over one agent to Naïve
## Kill switch (stop all spend)
`touch runs/KILL`. Every local run stops before its next model or tool call (status `killed`).
Remove the file to allow runs again. Hosted Naïve agents are not covered yet.

## Engine render or build is broken
## An agent is looping or burning budget
Local runs are capped three ways (all in `runs/spend.jsonl`): per run (`max_task_usd`, or `--max-usd`),
per agent per period (`cap_usd`/`period`), and globally per day (`LOCAL_SPEND_CAP_USD`, default $5).
A run also stops at `limits.max_turns`. Check spend: `runs/<run_id>/run.json`, or sum `runs/spend.jsonl`.

## Log a human intervention
