# any-co game studio

A game studio run by agents, built for the Naïve Autonomous Company Hackathon (YC SF, Sat Nov 7 1:00 PM PT to Sun Nov 8 11:00 AM PT).

Given a budget and the Steam catalog, the studio picks a game the market is missing, designs it, makes the art and code, tests it, markets it, and ships it. A human handles only identity and payment setup, and every intervention after the event starts is logged.

This repo is the **harness**: the infrastructure the agents run on. It contains no game content. The studio's agents make the game, in their own repo under `games/`.

- Plan: [`docs/plan.md`](docs/plan.md)
- Decisions: [`docs/decisions.md`](docs/decisions.md)
- Naïve platform notes: [`docs/naive-notes.md`](docs/naive-notes.md)
- Overnight operations: [`runbook.md`](runbook.md)

## What's here

| Path | What it is |
|---|---|
| `agents/` | One folder per agent: `spec.ts` (model, tools, budget, runner) and `system.md` (prompt). The spec is the source of truth for both runners. See [`agents/README.md`](agents/README.md). |
| `runner/` | The local agent loop (tool use, budgets, approval gate, crash recovery, kill switch) and the Naïve adapter. |
| `tools/` | Tools the agents use: Steam catalog queries, gap map, Greenlight, Steam reviews, and the decision and intervention ledger. |
| `window/` | The studio window, an Electron app for watching the studio run. See [`window/README.md`](window/README.md). |
| `scripts/` | Run one agent, validate specs, evals, Naïve connection check. |
| `docs/` | Plan, platform notes, game contracts, decisions. |

The studio has about 18 agents across Greenlight, design, art, audio, engineering, QA, marketing and ops, led by a Studio Head.

## How it works

- Each agent is a spec with a required USD budget. Agents run **locally** (our loop, any provider) or on **Naïve** (hosted), chosen per agent with `runner: local | naive`.
- Local runs are capped per run, per agent per period, and globally per day. Spend is recorded in `runs/spend.jsonl`.
- Every send or spend goes through the approval gate and is written to the ledger.
- Mechanical work (budget math, palette lock, schema checks) is deterministic code. Models only make judgment calls.
- Each run writes `runs/<run_id>/` with its transcript, output and workspace.

## Setup

Needs Node 22 or newer and Python 3.9 or newer (the Python tools use only the standard library).

```bash
npm install
cp .env.example .env     # fill in NAIVE_API_KEY and the provider keys you need
npm run naive:check      # confirm the Naïve connection
```

The Steam catalog goes in `data/` (gitignored). Read `data/README.md`, then run `python3 tools/catalog/prep.py`.

## Common commands

```bash
npm run agents -- list                     # list agent specs
npm run agents -- validate                 # check every spec
npm run agent -- <name> --task "..."       # run one agent locally -> runs/<run_id>/
npm test                                   # runner, tools and window adapter tests
npm run typecheck

npm run window:live:electron               # desktop window on real runs/
touch runs/KILL                            # kill switch: stop all spend (remove the file to resume)
```

## The studio window

`npm run window:live:electron` opens the studio window against the real `runs/` and `agents/`. It has the org chart, a live pulse of what each agent is doing, every run's loop, spend, and chat with the Studio Head. Chat is the one write path, and each message is logged as an intervention. See [`window/README.md`](window/README.md).

## Rules for this repo

- Harness and infrastructure only. No game concepts, design docs, art, store copy or game code, and never write inside `games/`.
- Every agent spec declares a budget.
- After Sat Nov 7, 1:00 PM PT, any change to this repo is a human intervention. Log it with a one-line reason.
- Secrets come from env or the Naïve vault, never from commits.

Coding agents: read [`CLAUDE.md`](CLAUDE.md) first.
