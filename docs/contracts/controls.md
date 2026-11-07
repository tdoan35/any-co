# controls

How the harness drives a running game.

## Launch flags (desktop build)

| Flag | Meaning |
|---|---|
| `--qa` | Enable the harness surface below. Ignored (warn, exit 0) on web. |
| `--seed N` | Seed every RNG stream from this integer. Required for reproducible runs. |
| `--time-scale X` | Multiply simulation speed by X (0.1–20). UI and audio may skip; simulation must not. |
| `--autoplay` | Start autoplay immediately (see autoplay.md). Without it the game waits for input. |
| `--policy ID` | Autoplay policy: `random`, `greedy`, or `script:PATH` (JSONL of inputs). |
| `--resolution WxH` | Window/backbuffer size, default 1280x720. Screenshots come out at this size. |
| `--exit-after-ticks N` | Quit cleanly after N simulation ticks (QA smoke). |

Unknown flags: ignore with a warning in events.jsonl, never crash.

## The `qa/` protocol (only while `--qa` is set)

The game creates `qa/` at startup and owns these files in it:

- **`qa/control.json`** — harness → game. The game polls this file **every frame**; when
  its `id` differs from the last executed one, it executes the command and only then
  overwrites `qa/ack.json`. A command that names a missing thing is an error ack, not a
  crash.
- **`qa/ack.json`** — game → harness: `{ "id": <same>, "ok": true }` or
  `{ "id": <same>, "ok": false, "error": "…" }`, plus command-specific results.
- **`qa/events.jsonl`** — append-only, flushed per event (see events.md).

Polling is file-content based (`id` compare), not mtime: harnesss may rewrite the file
in the same tick.

**Startup and readiness.** At startup the game clears its previous outputs (truncates
`qa/events.jsonl`, removes `qa/state.json`, `qa/run_summary.json` and `qa/shot-*.png`),
writes `qa/control.json` as `{"id": 0, "cmd": "noop"}`, and then writes
`qa/ack.json` as `{"id": 0, "ok": true, "ready": true}`. That ack is the ready signal: the
harness sends its first command only after it, and the game never rewrites
`qa/control.json` after it. Both sides write these files atomically (temp + rename).

**When the ack is written.** The ack means the command has *finished*: for `step`, after
the N frames have run and the game is paused again; for `dump_state` and `screenshot`,
after the file is complete on disk; for `quit`, after `run_summary.json` is written.

## Commands

```json
{"id": 7, "cmd": "pause"}                      // stop simulating; rendering may continue
{"id": 8, "cmd": "resume"}
{"id": 9, "cmd": "step", "frames": 60}         // advance exactly N frames, then pause
{"id": 10, "cmd": "dump_state"}                // write qa/state.json (ack carries the path)
{"id": 11, "cmd": "screenshot", "path": "qa/shot-0011.png"}
{"id": 12, "cmd": "quit"}                      // clean exit: writes run_summary.json first
```

- `id` is an increasing integer chosen by the harness; the game never reorders commands.
- `step` while not paused is an error ack ("already running").
- Commands are applied **between frames**, never mid-frame.

## Determinism requirements
- One tick = one fixed simulation step (e.g. 1/60 s), independent of real time; time-scale
  only changes how many ticks run per real second.
- With the game paused, `step 60` then dump must equal 60 natural ticks then dump, for the
  same seed and inputs.
