# Art generation providers — what the harness integrates (T3)

Research notes from the public docs (no API keys were used; nothing here was called for real):
PixelLab OpenAPI `https://api.pixellab.ai/v2/openapi.json` + `llms.txt`, and Retro Diffusion's
`https://github.com/Retro-Diffusion/api-examples` (`llms.txt`, verified 2026-09 by the provider).
`tools/art/generate.ts` implements exactly the flows below; the tests fake them over local HTTP.

## Retro Diffusion (`provider: "retrodiffusion"`)

- **Base URL** `https://api.retrodiffusion.ai` (env override `RETRO_DIFFUSION_BASE_URL`); v2 paths.
- **Auth** header `X-RD-Token: <key>` (keys look like `rdpk-…`); env `RETRO_DIFFUSION_API_KEY`.
  Paid submissions should carry a unique `Idempotency-Key`; we send a fresh UUID per call.
- **Generate**: `POST /v2/inferences` with `{prompt, prompt_style, width, height, num_images,
  seed?, input_image?, reference_images?: [base64…], input_palette?, remove_bg?,
  tile_x/tile_y?, frames_duration? (4|6|8|10|12|16), return_spritesheet?, check_cost?}` →
  `202 {status:"accepted", task_id, request_id}`. Poll `GET /v2/inferences/tasks/{task_id}`
  (~2 s) → `{status:"pending"|"running"|"succeeded"|"failed", result?, error?}`.
- **Result** (`result` on success): `base64_images: [raw base64 PNG/GIF]` and/or
  `output_urls: [hosted URLs]` (large animations arrive as URLs with `base64_images` empty —
  both must be handled), plus `balance_cost` (USD), `remaining_balance`, `model`, `request_id`.
- **Reference/anchor art**: `reference_images` (RD Pro styles, up to 9) guides subject/style
  consistency without redrawing; `input_image` is for img2img/pixelate. We send anchors as
  `reference_images`. Base64 is raw — never a `data:` URI.
- **Animation**: style-driven. `rd_animation__*` (prompt-driven GIF/spritesheet, fixed sizes),
  `rd_advanced_animation__*` (requires `input_image`, 32–256 px, `frames_duration` supported).
  We pass `frames_duration` when the caller asks for frames and request `return_spritesheet`
  so the deliverable is a PNG strip.
- **Sizes**: API validates 12×12–512×512; each style is tighter (RD Pro 12–256, Plus/Fast
  16–384, several fixed sizes for animation styles). Live limits: `GET /v2/styles/selector`.
- **Errors**: v2 JSON `{error:{code,message,request_id}}`; 402 `not_enough_balance`,
  429 rate limit, 5xx provider failures (auto-refunded). `check_cost: true` is a free dry run.
- **Cost reporting**: `balance_cost` in USD on success — **reported**, we pass it through.

### Price table (USD per request) — used only when the response omits `balance_cost`, then marked `estimated`

| style family | price |
| --- | --- |
| `rd_fast__*`, `rd_mini__fast_*` | $0.03 × num_images |
| `rd_plus__*`, `rd_mini__*` (non-fast) | $0.06 × num_images |
| `rd_tile__tileset*` | $0.10 |
| `rd_tile__*` (single_tile/tile_variation/tile_object/scene_object) | $0.06 × num_images |
| `rd_advanced_animation__rotate` | $0.10 |
| `rd_advanced_animation__custom_action`, `__subtle_motion` | $0.25 |
| `rd_advanced_animation__*` (other) | $0.14 |
| `rd_animation__any_animation`, `__big_animation`, `__8_dir_rotation` | $0.25 |
| `rd_animation__*` (other) | $0.07 |
| `rd_pro__fps_weapon` | $0.25 |
| `rd_pro__*` (other) | $0.18 × num_images |
| anything else (conservative default) | $0.18 × num_images |

## PixelLab (`provider: "pixellab"`)

- **Base URL** `https://api.pixellab.ai` (env override `PIXELLAB_BASE_URL`); v2 paths.
- **Auth** `Authorization: Bearer <token>`; env `PIXELLAB_API_KEY`.
- **Generate**: `POST /v2/generate-image-v2` with `{description (1–2000 chars),
  image_size:{width,height} (16–792 × 16–688), seed?, no_background? (default true),
  reference_images?: [{image:{base64, format?}, size:{width,height}, usage_description?}]
  (up to 4, size required, >1024 px downscaled), style_image?, style_options?,
  target_palette?: {colors?: ["#rrggbb"…], name?, max_colors? 2–64}}` →
  `202 {background_job_id, status:"processing", usage?: {type:"usd", usd} | null}`.
- **Poll**: `GET /v2/background-jobs/{job_id}` → `{id, status:"processing"|"completed"|"failed",
  created_at, usage?, last_response?}`; on `completed` the images live inside
  `last_response` as base64 image objects (`image` / `images` / nested results).
- **Animation**: separate endpoints (`/animate-with-text-v3`, `/characters/animations`, `/vfx`)
  need character ids or a reference frame pipeline we do not wrap yet — our interface rejects
  `frames` for pixellab. Documented for a later ticket.
- **Cost reporting**: `usage.usd` when present (subscription `generations` usage has no USD
  value) — reported; when `usage` is null we fall back to the estimate below, marked
  `estimated`.

### Price table — fallback only

| endpoint | price |
| --- | --- |
| `POST /v2/generate-image-v2` | $0.02 per request (the API's own usage examples show $0.02) |

## Cost policy

Every generation returns `cost_micro_usd` and `cost_source: "reported" | "estimated"`.
Reported beats estimated; a paid call never reports 0 (an estimate is used instead).
This spend is **budget-capped like inference** (per-agent period caps in the spec, global
daily cap in the runner), not per-call approved — recorded in `docs/decisions.md`.
