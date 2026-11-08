# any-co studio window

The desktop window for watching the any-co game studio run, for Ty and the judges. It shows the org chart, what each agent is doing, every run's loop, spend, and decisions. It reads real studio data from `runs/` and `agents/` through a local adapter.

Lifted from the Fabric web app (Vite, React 19, React Router, Tailwind v4, Electron). Details for coding agents are in `AGENTS.md`.

## Run it

From the repo root:

```bash
npm run window:live            # adapter (port 8787) + browser UI on real runs/
npm run window:live:electron   # adapter + desktop app
npm run window:live:both       # both studios, switchable (browser)
npm run window:live:both:electron  # both studios, switchable (desktop app)
npm run window:server          # adapter alone
npm run window:check           # validate real runs/ + agents/ against the UI contract
npm run window:dev             # UI with mock data only (no adapter)
npm run window:electron        # desktop app with mock data only
npm run window:typecheck       # UI + adapter
npm run window:build
```

The adapter restarts are manual: agent specs are read once at startup.

## Both studios in one window

`window:live:both` starts one window that switches between two studios: studio 1 (this
Mac's live adapter, default port 8787) and studio 2 (the ty-ubuntu mirror, served
read-only). It reuses adapters that are already listening — the EA's mirror adapter on
8790, or a live 8787 — and starts its own only where nothing answers, stopping just
those on exit. The switcher sits under the brand in the sidebar; the selection is
remembered per viewer. Studio 2 shows a read-only tag and its chat composer is disabled:
mirror adapters refuse writes (403).

Which studios appear comes from `VITE_STUDIOS`, a JSON array of
`{"id","label","api","readOnly?"}` entries. Unset, the window behaves exactly as the
single-studio launchers above (one API base from `VITE_API_URL`, no switcher). Labels
come from the config; the window never hard-codes studio or game names.

## Pages

- **Studio**: the org chart. Departments, teams and agents with a live presence dot. The Studio Head sits at the top.
- **Weave**: the studio deck. Who is working, a pulse of run starts and ends, and the intervention count. The approval inbox is empty until the approval ledger exists.
- **Work**: runs as a board. Open one to watch its loop (model replies, tool calls, results, wrap-up notes).
- **Chat** (home): talk to the Studio Head. It answers from the studio's runs, spend and roster through read-only tools. It cannot start or stop agents yet.

## Interventions

Chat is the one write path. Every message you send after the event start (`STUDIO_EVENT_START`, default Sat Nov 7 1:00 PM PT) is appended to `runs/ledger.jsonl` as a human intervention, even a status question. Sessions are stored in `runs/chat/`. Before the event, wipe `runs/` once; never after it starts.

## Watching another folder's runs (mirror)
`STUDIO_RUNS_DIR=<path>` points the adapter at another runs folder (relative paths resolve against the repo root);
approvals, chat, the board, the ledger and the file watcher all follow it, and the adapter logs the effective dir at
startup. A window on a runs dir outside this repo's own `runs/` is read-only (also forced by `STUDIO_WINDOW_READONLY=1`):
the chat POSTs answer 403 `read-only window (mirror)`. A mirror is rsync'd with `--delete`, so writes there vanish,
and a chat turn would spend the viewer's key and append interventions to a ledger copy.

## How it fits together

```
runs/ + agents/  ->  window/server (adapter)  ->  src/lib/api  ->  React UI  ->  Electron
```

- `server/runs.ts`: run transcripts to the UI's run events
- `server/registry.ts`: agent specs to agents, teams and the org chart
- `server/weave.ts`: presence and the pulse
- `server/chat.ts`: Studio Head chat sessions and intervention logging
- `server/index.ts`: HTTP routes. Only localhost and the Electron origins may call it.
- `packages/contracts`: the schemas the UI and adapter share
- `packages/fixtures`: sample data for mock mode

The window must not contain game content.
