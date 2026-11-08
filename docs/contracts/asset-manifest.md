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
      "anchor_mode": "style",
      "anim": {"mode": "cutout", "parts": ["body", "eye"]}
    },
    {
      "id": "player-hurt",
      "type": "sprite",
      "path": "assets/sprites/player-hurt.png",
      "size": {"w": 16, "h": 16},
      "palette": ["#1a1c2c", "#ffcd75", "#b13e53"],
      "anchor": "player",
      "anchor_mode": "same-subject"
    }
  ]
}
```

## Rules
- **`palette` (file-level) is the locked palette.** Every asset's `palette` must be a
  subset; the gate enforces it in code against the actual pixels, not this list.
- **`anchor`** names the anchor sheet an asset was generated from (`null` for anchors).
  Every non-anchor sprite must have one — that's how drift is measured.
- **`anchor_mode`** says how an asset is measured against its anchor:
  - `"same-subject"`: frames or poses of the anchor's own subject. The gate compares pixels
    (`anchor_drift`, frame 0 vs anchor frame 0). The default for strips (`frames` > 1).
  - `"style"`: a different subject in the anchor's style (another item in the same icon set,
    another character in the same portrait framing, a tile). Pixel drift is skipped; the gate checks the
    color mix (`paletteDistance`), contrast span (`lumaRange` vs `anchorLumaRange`) and outline
    (`outlineShare`) against the anchor, on top of the palette, size, grid and frame checks.
  - A single-frame asset with an `anchor` must declare one; the gate refuses it otherwise.
    Anchor sheets (`anchor: null`) take none. Different silhouettes can hang off different anchors.
- **`outline`** (optional, file-level and per entry): the outline color `#rrggbb`, or `null`
  for "no outline" (e.g. tiles). In `style` mode the gate uses the entry's, else the file's,
  else the anchor's own edge color.
- **`size` is the size of one frame; a strip of N frames is N×size.w wide.** `size.h` is the
  file height. The gate checks `file.w == size.w × frames` and `file.h == size.h`.
  `size` is a multiple of `grid`; frames are laid out as a horizontal strip.
- Types: `sprite`, `tileset`, `ui`, `audio`, `font`, `other`. `audio` entries carry
  `{"duration_s": n}` instead of size/frames.
- Every asset file on disk appears in the manifest, and every manifest path exists — the
  gate fails on both mismatches.
- Regenerations overwrite the same `id`/`path`; ids are stable so QA can diff builds.
