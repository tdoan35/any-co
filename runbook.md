# Runbook

For overnight operations. Fill in as the harness takes shape.

## Start the studio
## Check health (what "fine" looks like)
- `npm run runs -- orphans` prints `no orphaned runs`: every run at status "running" has a live
  pid on this host and a heartbeat under 10 min old (`STUDIO_ORPHAN_AFTER_MIN` to change).
- Each `runs/<run_id>/run.json` shows `pid`, `host`, `heartbeat_at` (refreshed every turn) and
  `spent_micro_usd` within `limits.run_cap`.
- Day spend — the sum of `runs/spend.jsonl` — stays under `LOCAL_SPEND_CAP_USD` (default $5).

## Restart the local runner
- After a crash, sleep or reboot: `npm run runs -- orphans`, then
  `npm run runs -- resume <run_id> [--max-usd N]` (or `npm run agent -- --resume <run_id>`).
- A resume continues the same run id, workspace and spend; turns and spend continue from the
  transcript and `runs/spend.jsonl`, and every cap still applies. A tool call the crash
  interrupted is answered with an error result ("interrupted by a crash; check the current
  state before retrying") and is never re-executed, so sends/uploads cannot fire twice.
- A run is resumable only when its process is verifiably gone and its transcript rebuilds
  exactly; anything else (still alive, finished, spec changed, older recording) is refused
  with the reason printed.
## Cut over one agent to Naïve
## Kill switch (stop all spend)
`touch runs/KILL`. Every local run stops before its next model or tool call (status `killed`).
Remove the file to allow runs again. Hosted Naïve agents are not covered yet.

## Engine render or build is broken
## An agent is looping or burning budget
Local runs are capped three ways (all in `runs/spend.jsonl`): per run (`max_task_usd`, or `--max-usd`),
per agent per period (`cap_usd`/`period`), and globally per day (`LOCAL_SPEND_CAP_USD`, default $5).
A run also stops at `limits.max_turns`. Check spend: `runs/<run_id>/run.json`, or sum `runs/spend.jsonl`.
To continue a crashed run on a shorter leash: `npm run runs -- resume <run_id> --max-usd 0.25`.
To stop everything now: the kill switch below.

## Log a human intervention
