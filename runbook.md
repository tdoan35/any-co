# Runbook

For overnight operations. Fill in as the harness takes shape.

## Start the studio
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
