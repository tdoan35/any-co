# autoplay

A bot plays the game so QA can run hundreds of runs overnight and the trailer tool can
capture staged footage.

## Policies (`--policy ID`)
- **`random`** — uniformly random valid inputs. Baseline: does the game survive dumb play?
- **`greedy`** — plays toward the game's own scoring/progression signals (built by the
  gameplay engineers alongside the feature; no perfect play required, only benign play).
- **`script:PATH`** — JSONL file of inputs applied at given ticks. The trailer tool and
  regression tests use this to replay exact runs.

Script line shape (one JSON object per line):

```json
{"tick": 120, "input": "move", "args": {"x": 3, "y": 0}}
{"tick": 240, "input": "attack"}
{"tick": 300, "input": "ui", "args": {"key": "confirm"}}
```

- `input` names come from the game's own input map, listed in `qa/input_map.json` at
  startup: `{ "inputs": [{"name": "move", "args_schema": "x,y in tiles"}], "ui": [...] }`.
- Inputs before run start are queued, not dropped. After `run.over`, inputs are ignored.

## Requirements
- Autoplay is a **player replacement**, not a cheat: it presses the same buttons a player
  could. It may read state (bots may be omniscient); it may not call internal APIs that
  mutate state directly.
- Determinism: same seed + same policy + same script = identical state dumps, every time.
  `random` uses the seeded stream, not the system RNG.
- A full autoplay run must terminate on its own or via `--exit-after-ticks`; a bot that
  idles forever in a menu is a QA finding (softlock), not acceptable behavior.
- Autoplay works with `--time-scale` up to 10 without dropped inputs (inputs bind to
  ticks, not real time).
