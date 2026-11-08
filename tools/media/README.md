# tools/media — trailer, GIF and screenshot capture against the contracts

Marketing's capture tool. It is built only against `docs/contracts/` (controls launch flags +
`qa/` protocol, autoplay `script:PATH` policy, screenshot, events, state-dump), never against a
specific game. The marketing agent decides *what* to capture and writes the edit plan; this code
only executes it.

| File | Does |
|---|---|
| `protocol.ts` | Small `qa/` client: ready ack, atomic `control.json` + ack wait, `events.jsonl` tail |
| `capture.ts` | Launches the desktop build (argv array, cwd = game clone) and captures stills or footage |
| `edit.ts` | ffmpeg edit plans (argv, no shell) + ffprobe summary |
| `media.ts` | Human CLI: `npm run media -- probe <file>` / `edit <plan.json>` |
| `testdata/fake-game.mjs` | Test double that speaks the `qa/` protocol (not a game; never under `games/`) |

## Capture modes
Launch argv: `<launch…> [--write-movie <file>] [<separator>] --qa --seed N --time-scale X --autoplay
--policy <random|greedy|script:PATH> --resolution WxH [--exit-after-ticks N]`. Godot needs
`separator: "--"` so engine args stay before user args.

- **ticks**: wait for the ready ack, `pause`, `dump_state` for the current tick, then `step` to
  each listed tick and `screenshot`. Exact frames for a storyboard; ticks already passed are
  skipped with a note.
- **events**: run free; on a listed event (`every`, `max`, overall `max_shots`) `pause` →
  `dump_state` → `screenshot` → `resume`. Stops at `run_end`, the shot cap, exit or the deadline.
- **movie**: engine movie mode (`--write-movie`, docs/decisions.md engine spike) with
  `--exit-after-ticks`; waits for the exit and checks the file.

Before spawning, `capture()` removes `qa/ack.json` and `qa/control.json`, and it only accepts a ready
ack written after the spawn (mtime). A movie capture leaves `{id:0, ready:true}` behind, which used
to pass for the next game before it booted (R16-1). The game's process group is registered with
`tools/proc/reaper.ts`, so it dies with the runner on exit, SIGINT/SIGTERM/SIGHUP, or kill -9 (via a
watchdog). Every mode has an overall deadline. After `quit` the game gets a grace period, then its process
group gets SIGTERM, then SIGKILL. Stills are checked against `--resolution` (screenshot.md), and a
mismatch is reported in `notes`.

## Edit plan (`media_edit`, JSON written by the marketing agent)
```json
{"schema_version": 1,
 "clips": [{"still": "media/title.png", "duration_s": 2}, {"source": "media/run1/footage.avi", "start_s": 3.5, "end_s": 7}],
 "output": {"path": "media/trailer.mp4", "format": "mp4", "width": 1280, "height": 720, "fps": 30,
            "max_bytes": 20000000, "max_duration_s": 60}}
```
Clips play in order. Each is normalized to a lossless RGB intermediate (same size and fps,
`scale=…:flags=neighbor`, letterboxed), then concatenated and encoded once: H.264 `yuv420p`
mp4 (even dimensions) or GIF via `palettegen`/`paletteuse` with no dithering. A clip past its
source's end, a cap breach (the output is deleted), or a malformed plan fails with the reason.

## Runner capability `media_capture`
Tools `media_capture`, `media_edit`, `media_probe`. Inputs are workspace-relative (the game clone
is `<workspace>/game`) and outputs go under `<workspace>/media/`. `launch[0]` must be the engine
binary (`GODOT_BIN`, default `godot`) or a desktop build under the clone's `dist/`. Extra args are
allowlisted: `--headless`, `--windowed`, `--rendering-method|--rendering-driver|--display-driver|--audio-driver <name>`,
and for the engine `--path .` (the clone only). `--script`, `--main-pack`, `--editor` and the like are
refused. Trust gap: `dist/` sits in an agent-writable clone, so don't grant media_capture alongside
write access to `game/` without accepting that. Inputs to ffmpeg/ffprobe run with
`-protocol_whitelist file`; playlists (HLS, ffconcat, DASH) are refused by their header and by
probed format, and clip demuxers are pinned to mov/avi/matroska/gif/apng (R16-4). A
`script:` policy path must exist in the clone. No spec grants it yet.

Needs `ffmpeg`/`ffprobe` on PATH (`FFMPEG_BIN`/`FFPROBE_BIN` override) for edit, probe and the
movie test.

## Tests
`media.test.ts`: argv shape; ticks (shots at exact ticks, checked by the double's own log),
events (every/max, run_end), timeouts with kill (no ready ack, ignored quit), spawn failure, movie
mode, mp4/GIF edits on a synthetic ffmpeg `testsrc` clip (codec, pix_fmt, size, fps, duration,
nearest-neighbour single colour), caps and bad plans, and capability confinement. ffmpeg tests
skip with a message when ffmpeg is missing. Everything runs in OS temp dirs, never `runs/` or `games/`.

## Duplication to consolidate
`protocol.ts` duplicates part of the QA driver's `qa/` client (tools/qa, built on another branch).
Merge them into one shared module once both land.
