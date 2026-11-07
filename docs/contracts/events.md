# events

The game narrates what happens so QA can trigger captures, count events, and replay bugs.

## Interface
Append-only JSONL at `qa/events.jsonl`, one object per line, flushed per event. Written
only while `--qa` is set.

Every event:

```json
{"schema_version": 1, "tick": 4210, "event": "hit", "data": {"entity": "enemy-12", "amount": 3}}
```

## Standard events (required; the game may add more)

| `event` | When | `data` (required keys) |
|---|---|---|
| `run_start` | a run begins (after menu) | `seed` |
| `spawn` | entity becomes active | `id`, `type`, `x`, `y` |
| `hit` | damage dealt to player or entity | `target`, `source`, `amount` |
| `death` | entity or player dies | `target`, `cause` |
| `levelup` / `wave` / `stage` | progression milestone | `level` (or `wave`/`stage`) |
| `pickup` | item or resource gained | `item`, `count` |
| `menu_open` | any menu or overlay takes control | `menu` |
| `run_end` | run ends (win, loss, quit) | `outcome` in `win`, `loss`, `quit` |
| `error` | non-fatal error (also in state `errors[]`) | `message` |

Rules:
- Events are facts, not predictions: `death` fires when it happens, not when hp will reach
  0.
- `data` values are JSON scalars/objects; every key above is required even when empty
  (`""`, `0`).
- Event order within a tick is simulation order; the harness must not depend on ordering
  across entities.
- An event name never contains spaces; use `snake_case`.
