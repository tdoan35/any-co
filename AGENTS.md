# AGENTS.md — any-co studio harness

Instructions for coding agents working in this repo. Read fully before every task.

## What this repo is
The **harness** for an autonomous game studio built for the Naïve Autonomous Company
Hackathon (YC SF, Sat Nov 7 1:00 PM → Sun Nov 8 11:00 AM freeze). Agents run the studio:
they pick a game from the Steam catalog, design it, make art and code, test, market, and ship it.
This repo is the infrastructure those agents run on. Full plan: `docs/plan.md`.

## The autonomy boundary (hard rule)
Judges score how much of the company runs without a human. So:
- **Build harness and infrastructure only:** runner, agent specs, tools, contracts, scripts, the studio window.
- **Never write game content:** no game concepts, design docs, style bibles, art, levels,
  store copy, marketing posts, or game code. The studio's agents produce all of that during the event.
- **Never write inside `games/`.** That folder holds the studio's game repo, made by its agents.
- If a task seems to need game content, stop and ask instead.

## Architecture rules
1. **Agent specs in `agents/` are the source of truth.** Each spec has prompt, model, tools,
   skills, budget, and `runner: local | naive`. Both runners read the same spec. Local agents
   may use non-Naïve inference (e.g. superfast providers for Eng); the event requires the
   Naïve SDK, not Naïve only.
2. **Every agent spec declares a budget.** No exceptions.
3. **Hand-offs go through Naïve by default:** board cards between agents, Files for artifacts
   other agents or judges need. Local state is fine for tool data (e.g. `data/catalog.sqlite`),
   caches, and run logs, as long as no other agent depends on it.
4. **Every send or spend goes through the approval gate** and is written to the ledger
   (`studio.log_decision`, `studio.record_intervention`).
5. **Deterministic code for anything mechanical:** palette lock, sprite grid snap, budget math,
   gate checks, schema validation. LLMs only make judgment calls.
6. **The game must implement `docs/contracts/`.** QA, the art gate, and trailer capture are
   built against those interfaces, never against a specific game.
7. **Local runner must survive the night:** crash recovery, resume from board state,
   tracked inference spend, kill switch.

## Platform notes
Naïve constraints and API naming: `docs/naive-notes.md`. Check it before calling the SDK.
SDK `@usenaive-sdk/managed-agents`, CLI `naive`, API host `https://api.vetta.sh`.
Docs index: https://usenaive.ai/docs/llms.txt

## Data
Steam catalog: `data/steam-games-dataset/`. Read `data/README.md` first.
The CSV header is broken, and the JSON is too big to load in the 3 GB VM.

## Layout
```
agents/      agent specs
runner/      local loop + Naïve adapter
tools/       MCP tools (ledger, art post-processing, QA harness, itch/Steam upload)
scripts/     smoke test, cutover-one-agent, kill switch
window/      studio window for judges (read-only; chat with the Studio Head is the one write path, logged as interventions)
docs/        plan, platform notes, contracts, decisions
data/        datasets (gitignored)
games/       studio-made game repos (gitignored, separate git repos)
```

## Commands
TODO: fill in as they exist.
- install: `npm install` (Node 22+); Python tools are stdlib-only (3.9+)
- check Naïve connection: `npm run naive:check` (needs `NAIVE_API_KEY` in `.env`)
- prep Steam catalog: `python3 tools/catalog/prep.py` → `data/catalog.sqlite`
- studio window: `npm run window:live` (adapter + browser UI on real runs/), `npm run window:live:electron` (adapter + desktop);
  `window:dev` / `window:electron` = mock data only; `window:server` = adapter alone; `window:check` = validate real runs vs UI contract
- test: `npm test` (spec loader + catalog smoke); `npm run typecheck`
- run the studio: `npm run studio` — board dispatcher (local agents on due cards; `--once`, `--max-parallel N`, `--poll-s S`);
  board backend `STUDIO_BOARD=local|naive` (see runbook.md "Start the studio")
- agent specs: `npm run agents -- list | show <name> | validate [--remote]`
- run one agent locally: `npm run agent -- <name> --task "..." [--model id] [--max-usd N]` → `runs/<run_id>/`
- run toy task end to end: `npm run agent -- toy-catalog-reporter --task "Report the catalog dataset facts."`
- cut over one agent to Naïve:
- approvals queue: `npm run approvals -- list | show <id> | approve <id> [--note "..."] | deny <id> --note "..."` (decide gated tool calls; every decision ledgered)
- gap map: `tools/gapmap/README.md` (embed → build → render)
- eval Market Analyst: `npm run eval:market-analyst -- runs/<run_id>` (see `agents/market-analyst/eval/`)
- kill switch: `touch runs/KILL` (remove to resume); or `STUDIO_KILL=1`

## Conventions
- TypeScript for the harness (Naïve SDK: `@usenaive-sdk/managed-agents`); Python is fine for data jobs.
- Record tool and library choices in `docs/decisions.md`.
- Secrets only from env or the Naïve vault. Never commit keys. Keep `.env.example` current.
- Every tool in `tools/` ships with a smoke test.
- Keep this file under ~120 lines. Put detail in `docs/`.

## During the hackathon
Any change to this repo after **Sat Nov 7, 1:00 PM PT** is a human intervention.
Log it in the intervention ledger with a one-line reason, even for small fixes.
