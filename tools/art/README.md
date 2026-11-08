# tools/art — deterministic art post-processing and the asset gate

Mechanical art work is code, not LLM judgment (AGENTS.md rule 5, docs/plan.md §6 Art).
Everything here is pure TypeScript with no dependencies beyond node:zlib: same input →
byte-identical output. The studio's Art Director picks the palette; **no default or
suggested palette lives in this repo** — callers always pass one.

## Commands (`npm run art -- <cmd>`, JSON on stdout)

```
lock    <in.png> <out.png> --palette "#rrggbb,#rrggbb,..." [--alpha-threshold N]
snap    <in.png> <out.png> --w N --h N
outline <in.png> <out.png> --color "#rrggbb" [--mode outer]
strip   <in.png> --frames N [--out-dir DIR]        (default: <in>-frames/)
sheet   <out.png> --frames "a.png,b.png,..." [--anchor N] [--scale N] [--gap N]
gate    <game-repo-dir> [--schema <asset.schema.json>]
providers [--clear <pixellab|retrodiffusion>]   credit state; clearing an exhausted provider is human-only
```

Exit codes: 0 = ok, 1 = gate verdict fail, 2 = usage error or crash (bad args, unreadable file). `sheet` also writes
a `<out>.cells.json` sidecar mapping cell rectangles → frame index. `gate` prints the
full report and exits 1 when the repo fails.

## Art-only merges (`merge.ts`, T46)

`npm run art -- merge <game-dir> <agent/branch> [--dry-run]` (operator; refused when an agent started the process) and the
dispatcher hook (an artist's card closing done with `complete: true`; `STUDIO_AUTO_ART_MERGE=off` disables it) merge an
`agent/*` branch into the game repo's main with no LLM, only if ALL hold:

1. `git diff --name-only main...<branch>` touches only `assets/**` (manifest and Godot `.import`/`.uid` sidecars included) and
   `art/**` (helper scripts and scratch sheets there are inert data); engine code (.gd, .tscn, .tres, ...) anywhere is refused; else "not art-only: <paths>".
2. In a temp clone (never the live checkout): fast-forward, or a clean `--no-ff` merge; a conflict aborts with
   "conflict: <paths> → needs a tech-lead card".
3. `runGate` on the MERGED tree is ok; else the gate summary (failed ids, missing, unlisted, manifest errors).

Then it pushes main to the game repo (games/<slug>, `updateInstead` updates its checkout) through the single-merger
pre-receive hook with the operator override `ANYCO_ALLOW_MAIN=1`, and writes ONE ledger decision (topic `art.merge`). A
refusal pushes nothing. A per-repo lock (`runs/locks/art-merge-<repo>.lock`, stale when its pid is gone) serializes merges; if
main moved during the push (a tech-lead merge), it retries once from the new main.


- **PNG codec** (`png.ts`): pure TS on node:zlib. Decodes 8-bit RGBA, RGB, grayscale,
  grayscale+alpha, and indexed (PLTE + tRNS), all five filter types, non-interlaced;
  rejects interlaced and 16-bit files with a clear error, verifies CRCs. Encodes 8-bit
  RGBA (filter type 0), deterministically.
- **lockPalette**: alpha binarized at `alphaThreshold` (default 128: ≥ → opaque, < →
  transparent (0,0,0,0)); each opaque pixel snaps to the nearest palette color by OKLab
  distance; ties go to the earlier palette entry. Stats: pixels changed, max distance.
- **snapToGrid**: downscale to exactly w×h; each cell takes its most frequent exact RGBA
  color (transparent votes like any color); count ties go to the lexicographically
  smallest (r,g,b,a) tuple. Cell bounds are proportional, so fractional scales work;
  reports `scaleX/scaleY/uniform/integerScale`.
- **addOutline**: `mode: "outer"` only — 1 px outline on transparent pixels 4-adjacent
  to opaque (alpha ≠ 0) pixels; opaque pixels are untouched.
- **contactSheet**: one row, anchor frame first, integer scale (nearest-neighbor), gap
  in transparent pixels; all frames must share one size.
- **splitStrip**: horizontal strip → equal frames; width must divide by the frame count.

## Gate (`gate.ts`)

Checks a game repo's `assets/manifest.json` against
[docs/contracts/asset.schema.json](../../docs/contracts/asset.schema.json) plus pixel
truth, without loading the game:

| check | rule |
| --- | --- |
| manifest | schema-valid (small validator for exactly the schema's keywords — an unknown keyword throws instead of weakening the gate), unique asset ids |
| files | every manifest path exists; every file under `assets/` is listed (manifest.json itself exempt); symlinks under `assets/` are reported and fail (never followed) |
| path_safe | manifest paths must normalize to a location under `assets/` — `..` escapes are a failing check and are never probed on disk |
| palette_subset | the asset's declared palette ⊆ the locked (file-level) palette |
| pixels_in_palette | off-palette share of **opaque** pixels ≤ threshold (a pixel matches iff fully transparent or fully opaque with in-palette RGB) |
| size | `size` is one frame: `file.w == size.w × frames` and `file.h == size.h`; PNG assets must declare one |
| grid | the frame size (`file.w / frames` × `file.h`) is a multiple of `grid` |
| frames | strip width divides by `frames` |
| anchor | non-anchor sprites name an existing, non-self anchor id |
| frame_drift | max fraction of differing pixels between consecutive frames ≤ threshold |
| anchor_mode | an asset with an anchor has a drift basis: declared `same-subject` / `style`, or `same-subject` by default for strips; a single-frame asset with an anchor and no mode fails, and so does a mode on an anchor sheet |
| anchor_drift | `same-subject`: asset frame 0 vs anchor frame 0 differing fraction ≤ threshold (null/skip when frame sizes differ or the anchor layout is invalid); `style`: skipped |
| style_similarity | `style` only: color-mix distance (total variation of the color histograms of **non-outline** opaque pixels, 0 = same mix, 1 = no color shared; the resolved outline color is excluded) ≤ `maxPaletteDistance`, and \|luma range − anchor luma range\| ≤ `maxLumaRangeDelta` (range = p95 − p5 of opaque-pixel luma, 0..1); sizes may differ |
| style_outline | `style` only: share of frame-0 edge pixels (opaque, 4-adjacent to transparent) in the outline color ≥ `minOutlineShare`. Color = entry `outline`, else manifest `outline`, else the anchor's dominant edge color (when it covers ≥ `minOutlineShare` of the anchor's edge); `null` = no outline expected |

Non-PNG assets (audio, .ttf fonts) are checked for existence only; malformed frame
layouts skip the drift checks (the `frames` check already fails).

Thresholds (options to `runGate` / defaults):

```json
{ "maxOffPaletteShare": 0, "maxFrameDrift": 0.5, "maxAnchorDrift": 0.5,
  "maxPaletteDistance": 0.95, "maxLumaRangeDelta": 0.4, "minOutlineShare": 0.8 }
```

Report shape: `{ ok, manifest, files, assets: [{ id, path, type, pass, checks[], numbers }], thresholds }`.
`numbers`: `offPaletteShare`, `frameDrift[]`, `anchorDrift`, `anchorMode`, and in `style` mode `paletteDistance`,
`lumaRange`, `anchorLumaRange`, `outlineColor`, `outlineShare`.
`ok` is false when the manifest is invalid, files are missing/unlisted, or any check fails.

## Runner capability

Animation: `art_generate` with `frames`. Retro Diffusion uses animation styles (`frames_duration`
4|6|8|10|12|16). PixelLab animates a reference still with the prompt as the action
(animate-with-text-v3: 4–16 even frames, ≤ 256 px per side, w×h×frames ≤ 524,288; width/height = the
reference's size). Both write one horizontal strip per animation (N·w × h), the layout `gate` checks.
After a PixelLab timeout, the error names a `job_id`. Collect that job with `resume_job_id` (same inputs) instead
of regenerating: no new generation or charge. If a strip can't be built, the raw frames are saved as `<name>.frame-<i>.png`.

`art_generate` (generate.ts + credits.ts) is credit-aware because both providers run on free
trials (PROVIDERS.md "Credits"): `art_generate`, `art_quote` (free cost check), `art_anchor_winner`,
`art_providers` (read-only state). State: `runs/art-providers.json`, `runs/art-credits.jsonl`,
`runs/art-gallery.json` (env `ART_PROVIDERS_FILE` / `ART_CREDITS_FILE` / `ART_GALLERY_FILE`).
Comfy lanes (T41b): `COMFY_BASE_URLS=url|batch,url|batch` routes each call to the lane with the shortest /queue, failing over
on errors; the lane is logged (PROVIDERS.md "Lanes").
Default provider (T39b): `ART_DEFAULT_PROVIDER=comfy` makes a call with no provider comfy-only (reference required, no paid
fallback); unset keeps the anchor-winner rule (PROVIDERS.md "Default provider").
Guards (T39): `out` must be a named PNG under `game/assets/`; postprocess needs the manifest entry first; the per-asset cap
(1 + 2) is exact and race-free; past it, a new out path or an operator-approved redo (`art_redo` / `npm run art -- redo`).
PixelLab floor: set `PIXELLAB_MIN_REMAINING` (generations) and every pixellab call checks the live balance first;
at or below the floor, or if the call's estimate would cross it, the call goes to comfy or the procedural floor
without a PixelLab request (PROVIDERS.md "PixelLab floor").


`art_tools` (runner/tools/registry.ts) exposes `art_lock`, `art_snap`, `art_outline`,
`art_strip`, `art_sheet`, `art_gate` as model-facing tools. All paths are
workspace-relative (the game clone is `<workspace>/game`; `art_gate` defaults to it) and
go through the same path-safety rule as `workspace_write`. Naïve mapping is
`["bash", "read"]`; the hosted setup is not done yet, like the other local tools. No
agent spec grants it yet.

## Tests

`png.test.ts` (codec round-trip, every color type, every filter, rejections),
`ops.test.ts` (each operation, determinism, purity, tie rules), `gate.test.ts` (validator
accept/reject fixtures, passing and failing synthetic repos in temp dirs),
`art.test.ts` (CLI commands, exit codes, capability tools, path-escape refusal). All
images are synthesized in code — no binary fixtures, no real art.
