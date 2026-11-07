# screenshot

A PNG of the current frame, identical to what a player would see, capturable without a
human-visible window.

## Interface
`screenshot` command (see controls.md) with an optional `path` (default
`qa/shot-<tick>.png`). The ack carries the absolute path. The capture is of the frame
**after** the last completed simulation tick — never mid-frame.

## Requirements
- Format: PNG, 8-bit RGBA, exactly the current `--resolution`.
- The file is written atomically (temp + rename); the ack is sent only after the file is
  complete on disk.
- Content must match the state dump: if state says the player is at (x, y) with hp 3, the
  pixels show that. UI overlays (FPS counters, debug text) are off unless the command asks
  for `{"debug": true}`.
- Works under the desktop build with QA flags set, window visible or not. (Engine-level
  headless rendering is a harness concern; the game must not require a visible window or
  human input to capture.)

## Consumers
- QA visual checks: diff vs the previous build, missing-texture and blank-frame detection,
  vision-model comparison against the state dump.
- Trailer: scripted autoplay + screenshot at chosen ticks.
- Store pages: capsule and GIF capture use the same path.
