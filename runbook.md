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
Manual log: `npm run ledger -- intervention "<action>" "<reason>"`.

Approvals are interventions too. A gated (`ask`) tool call records a pending request in
`runs/approvals.jsonl` (also shown in the studio window inbox). Decide from the terminal:

    npm run approvals -- list                          # pending requests
    npm run approvals -- show <id>                     # full input before deciding
    npm run approvals -- approve <id> --note "why"     # note optional
    npm run approvals -- deny <id> --note "why"        # note required

Unattended runs (`--approvals queue`, the default without a TTY) block on this queue and expire
after `--approval-timeout-min` minutes (default 30). Every decision — approve, deny, expire,
`--approve-all` — is written to the ledger as an `approval` entry; human approve/deny counts as an
intervention in `ledger_recent`.

## Ship a build to itch
butler is not installed on this machine by default. The gated tool `itch_push` (build-release)
needs `BUTLER_BIN` (default `butler` on PATH) and `BUTLER_API_KEY` in env — the key is never
put in argv, results, or the ledger. The agent dry-runs first; a real push (`dry_run: false`)
waits on the approval queue:

    npm run approvals -- list             # pending request shows dir, target, build_id
    npm run approvals -- show <id>
    npm run approvals -- approve <id> --note "go"

Declined or timed out (`--approval-timeout-min`, default 30) = no push; every decision is in the
ledger. `itch_status` checks a channel's latest pushes without gating.

## Publish the studio site
The site is a Naïve App. Create it once (operator, live): `apps.create({ name: "studio-site",
type: "frontend_only" })` → put its id in env `STUDIO_SITE_APP_ID` (see docs/naive-notes.md, Apps).
build-release deploys `dist/web` (+ `site/` when marketing wrote one) through the ask-gated
`site_deploy`; a deploy or rollback waits on the approval queue:

    npm run approvals -- list               # shows the pending site_deploy (or rollback_to)
    npm run approvals -- show <id>
    npm run approvals -- approve <id> --note "go"

Builds run async: `site_status` shows the app URL, the latest deployment's build_id, and the
last 5 deployments; roll back with site_deploy `rollback_to: <deployment id>` (also gated).
Declined or timed out = nothing deployed; every decision is in the ledger.
