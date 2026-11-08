# Runbook

For overnight operations. Fill in as the harness takes shape.

## Start the studio
Overnight command (two terminals, from the repo root):
```
npm run studio -- --head-every-min 120 --max-parallel 2 --approval-timeout-min 30
npm run window:live          # operator view + chat; same board, read-only cards
```
Add `--head-now` for a Studio Head turn right at start (e.g. after a restart mid-event). Dry run first
with nothing at stake: `npm run studio -- --once --head-every-min 120 --head-now` runs one dispatch pass
plus one head turn and exits. Runs pick up the real agent names from `agents/`; the head's `board_create`
refuses any assignee that is not one of them, and refuses `studio-head` itself (it runs only by cadence or chat).
The head turn runs outside `--max-parallel`: count N dispatched runs + 1 head turn in the overnight spend math.
- The dispatcher polls the board (`--poll-s`, default 10) and runs local agents on due cards: one card
  per agent, `blocked_by` for order, `--max-parallel` runs at once. Done notes carry run id and spend.
- Studio Head cycle: every `--head-every-min` minutes one `studio-head` turn (single-flight) reads the
  board, runs, spend and ledger, then unblocks, cuts or assigns next work as cards, logging each steering
  decision. It also runs once at start when the board is empty and the ledger has a `greenlight.pick`,
  so work begins after the pick with no human. Off without the flag. The kill switch also stops head turns.
- Every run's `log_decision` writes the ledger in its runs dir (`STUDIO_LEDGER_FILE` overrides).
- Approvals: `ask` tools in dispatched runs wait on the queue — decide with
  `npm run approvals -- list | approve <id> | deny <id> --note "..."`; unanswered requests expire after
  `--approval-timeout-min`. `--approve-all` is for tests only (ledgered as auto).
- One loop per runs dir: `runs/studio.lock` (pid+host) refuses a second `npm run studio` while the first
  lives. If the holder died, the next start takes the lock over; on another host, remove the file by hand.
- Board backend: `STUDIO_BOARD=local` (default; `runs/board.jsonl`, override `STUDIO_BOARD_FILE`) or
  `STUDIO_BOARD=naive` (`NAIVE_API_KEY` + `STUDIO_BOARD_REF` = the Studio Head agent's `brd_`/`agt_` id).
- Honest close (T29): ticket-work agents (gameplay-engineer[-b], tech-lead, level-content-designer, art-director,
  sprite-artist, env-ui-artist, qa-lead, playtester, build-release) must submit `complete: true|false`. A run
  that ends `done` with `complete: false` closes its card as `blocked`, with a note starting "not complete:"
  and the agent's own summary, so downstream cards keep waiting. Budget/max-turns ends still block. Unblock
  it by fixing the cause and setting the card back to `todo` (or let the Studio Head's cycle triage it).
- Steer a card with a comment (T37): the next run's task gets an "Operator notes" section with the card's comments by
  `operator`, `studio-head` (board_comment) or a person in the Naïve app (`usr_`), oldest first, capped at 4,000 chars (newest kept).
  Dispatcher and agent comments are left out. A note reaches the next run, not one already in progress.
- Replace a stuck card (T38): create the new card with `supersedes: <old id>` (board_create). Cards waiting on the old one
  then wait on the new one, and the old card closes done "superseded by <new id>". The dispatcher finishes a half-done supersede
  on its next pass. A card replaced WITHOUT supersedes still strands its dependents: close the old one by hand.
- Restart-safe: a `doing` card whose claiming process is dead is requeued to `todo` with a comment; a card
  whose finished run could not be closed is left for a manual close (comment `dispatcher: close failed`).
- Stop: `touch runs/KILL` (no new dispatches; in-flight runs stop at their next call, cards requeue).

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
