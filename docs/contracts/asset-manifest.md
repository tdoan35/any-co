# asset-manifest

One file describes every asset in the game. The art gate, the palette lock, and the build
all read it — the gate never loads the game.

## Interface
`assets/manifest.json` at the game repo root, valid against
[asset.schema.json](asset.schema.json). One entry per asset file:

```json
{
  "schema_version": 1,
  "style_bible": "docs/style-bible.md",
  "grid": {"w": 16, "h": 16},
  "palette": ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#41a6f6"],
  "assets": [
    {
      "id": "player",
      "type": "sprite",
      "path": "assets/sprites/player.png",
      "size": {"w": 16, "h": 16},
      "frames": 4,
      "palette": ["#1a1c2c", "#ffcd75", "#a7f070"],
      "anchor": null,
      "anim": {"mode": "frame-strip", "fps": 8},
      "notes": "anchor sheet for characters"
    },
    {
      "id": "enemy-slug",
      "type": "sprite",
      "path": "assets/sprites/enemy-slug.png",
      "size": {"w": 16, "h": 16},
      "frames": 2,
      "palette": ["#1a1c2c", "#b13e53", "#ef7d57"],
      "anchor": "player",
      "anim": {"mode": "cutout", "parts": ["body", "eye"]}
    }
  ]
}
```

## Rules
- **`palette` (file-level) is the locked palette.** Every asset's `palette` must be a
  subset; the gate enforces it in code against the actual pixels, not this list.
- **`anchor`** names the anchor sheet an asset was generated from (`null` for anchors).
  Every non-anchor sprite must have one — that's how drift is measured.
- **`size` must be the real pixel size** and a multiple of `grid`; `frames` must match the
  file's frame layout (strip: horizontal).
- Types: `sprite`, `tileset`, `ui`, `audio`, `font`, `other`. `audio` entries carry
  `{"duration_s": n}` instead of size/frames.
- Every asset file on disk appears in the manifest, and every manifest path exists — the
  gate fails on both mismatches.
- Regenerations overwrite the same `id`/`path`; ids are stable so QA can diff builds.
