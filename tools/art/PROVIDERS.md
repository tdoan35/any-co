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
  429 rate limit, 5xx provider failures (auto-refunded). `check_cost: true` is a free dry run:
  `POST /v2/inferences` with the same body plus `check_cost: true` and **no** Idempotency-Key →
  `{balance_cost, model:"check_cost", base64_images:[], remaining_balance}`; nothing generated or charged.
- **Out of balance**: 402 `{error:{code:"not_enough_balance", message:"Not enough balance."}}`
  (the code is named on edit tools/Pixel Fixer; inferences document 402 "insufficient balance";
  v1 answered 400 `{"detail":[{"msg":"Not enough balance."}]}`). We treat any 402, or that code, as exhausted.
- **Balance**: `GET /v2/inferences/credits` (`X-RD-Token`) → `{credits, balance}`, `balance` in USD.
  Successful task results also carry `remaining_balance` (USD), which is what we log.
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
- **Animation (T23)**: `POST /v2/animate-with-text-v3` (OpenAPI read 2026-11-08) animates a given still
  from text. Request `AnimateWithTextV3Request` (additionalProperties false): `first_frame` (required,
  Base64Image `{type:"base64", base64, format:"png"}`, max 256×256), `action` (required, 1–1000 chars),
  `frame_count` (4–16, "must be even", default 8), optional `last_frame`, `seed`, `no_background`,
  `drift_threshold`, `enhance_prompt` (+0.05 generations; we never set it). Size limits: each side
  ≤ 256 and width × height × frame_count ≤ 524,288 (256×256 → at most 8 frames). Response 200 (not
  202) `{background_job_id, status, usage?, …}`; poll `GET /v2/background-jobs/{id}`, frames at
  `last_response.images`; a failed job's reason is `last_response.detail`. 402 "Insufficient credits",
  429 "Too many concurrent background jobs". No `image_size`: output frames are the first frame's size.
  We map: `reference` → first_frame, `prompt` → action, `frames` → frame_count, `transparent` →
  no_background, `seed`; width/height must equal the reference's size. Output: ONE horizontal strip
  (N·w × h, 1 row) per animation, built with `contactSheet` (no gap), the layout art_gate checks.
  **Undocumented, handled defensively:** the image item shape (we accept `{base64}` objects, raw or
  `data:` URI strings, and hosted URLs as strings or `{url}`), frame order (kept as returned), whether
  the input frame is echoed (frame_count + 1 frames → index 0 dropped, noted), and multiple candidates
  (a multiple of frame_count → that many strips, capped by `max_candidates`; any other count → one
  strip of everything, noted). The request example shows a `data:` URI for `first_frame.base64`; we
  send raw base64 like generate-image-v2. **Cost:** no generations cost per animation is documented and
  there is no dry run. `usage` may be `{type:"generations", generations: n}`, which we report;
  `generations_used` comes from the balance delta, else that usage. The USD charge to the run budget
  is a placeholder estimate of $0.10 per animation until a live call measures it. Other endpoints
  (`/animate-with-text-v2`, `/animate-pixminimax`, the skeleton and character/object flows) need Pro,
  keypoints, or a character id, or are beta, so we don't use them.
- **Never lose a billed job (T23b)**: animations default to a 600 s deadline (`ART_GENERATE_TIMEOUT_MS`
  overrides; stills stay 180 s). A timeout or poll failure after submit raises a ChargedFailure that
  carries the `job_id`; the job keeps running and is billed. Calling `art_generate` again with the same
  inputs plus `resume_job_id` polls `GET /v2/background-jobs/<id>` and writes the result exactly like a
  fresh call, with no submit, no charge, and no regeneration count (stills and animations). If the strip
  can't be built (mixed frame sizes etc.), every returned frame is saved byte-for-byte as
  `<out dir>/<name>.frame-<i>.png` before the error, and the error names the files.
- **Out of balance**: `402` "Insufficient credits" on `/generate-image-v2` (and the pixflux/pixen
  endpoints; "Insufficient generations" on character endpoints). The spec documents no body
  schema or code for it, so any 402 counts as exhausted.
- **Balance** (verified live 2026-11-07, Tier 1 subscription): `GET /v2/balance` (Bearer, free) →
  `{"credits":{"type":"usd","usd":0.0},"subscription":{"type":"generations","status":"active","plan":"Tier 1: Pixel Apprentice","generations":2000.0,"total":2000.0}}`.
  With an active `generations` subscription the balance is `subscription.generations` (remaining) of
  `subscription.total`, unit **generations**; otherwise `credits.usd`, unit usd (`pixellabBalance`).
  A 402 on a subscription account means the generations are spent: exhausted, as for credits.
- **Cost reporting**: `usage.usd` when present (subscription `generations` usage has no USD
  value) — reported; when `usage` is null we fall back to the estimate below, marked
  `estimated`.

### Price table — fallback only

| endpoint | price |
| --- | --- |
| `POST /v2/generate-image-v2` | $0.02 per request (the API's own usage examples show $0.02) |

## Local lab ComfyUI (`provider: "comfy"`, T31)

The isolated character-lab ComfyUI on ty-omarchy, for studio 2. Base URL from `COMFY_BASE_URL`
(default `http://100.96.19.87:8190`). **Port 8188 is production and is refused** (from the option or
the env, before any request). The provider never starts or stops servers; the operator starts the lab.

- **Recipe (frozen, from the lab's `HANDOFF.md` / `generate_agent_set.py`, read 2026-11-08):**
  checkpoint `NovaPixelILV3.safetensors`. With `reference`, IP-Adapter `ip_adapter_Noobtest_800000.bin`
  (`IPAdapterAdvanced`, weight 0.65, linear, concat, V only) with CLIP vision
  `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`. 768×768, 30 steps, CFG 7, `euler_ancestral` / `normal`,
  seed 42 unless the call passes one. Use the same seed per character for identity. No pose ControlNet.
  Without `reference` the graph is text-only (no IP-Adapter). `negative` is the negative prompt (default empty).
- **Flow:** `GET /system_stats` (5 s health probe) → `POST /upload/image` (the reference, named
  `anyco-ref-<sha256[:16]>.png`, overwrite) → `POST /prompt` → poll `GET /history/<prompt_id>` →
  `GET /view?filename&subfolder&type` per output of the SaveImage node.
- **Batch (T41):** `max_candidates` (art_generate default 4) becomes the latent `batch_size`, capped by `COMFY_MAX_BATCH`
  (default **2**, max 8). Every image of the batch is written as a candidate (`<out>-0.png`, `<out>-1.png`, …), and postprocess
  snaps each to the manifest entry of `out`; keep one at the manifest path and move the rest to the gallery. One seed per
  call: the sampler's noise differs per batch index, so candidates vary while the seed still pins identity (same seed and
  batch give the same images). Operator benchmark on the lab (RTX 4060 8 GB, frozen recipe 768², 30 steps): 1 image
  43.4 s (~1.4 img/min); batch 2 53.8 s for 2 (27 s/img, ~2.2 img/min) with ~4 GB VRAM still free; two concurrent prompts
  serialize in ComfyUI's queue (86 s wall, no speedup). Batch 4 at 768² is not verified on 8 GB, so the default cap is 2.
  One call is one generation for the per-asset cap, whatever the batch.
- **Output:** always 768×768, **opaque** (the recipe has no background removal). Pass
  `postprocess` (snap/lock/outline) to reach the manifest size, grid and palette. Stills only: `frames`
  is refused (animate the still with pixellab).
- **Cost:** `cost_micro_usd: 0`, `cost_source: "local"`. No balance read, no `art-credits.jsonl`
  line, no `generations_used`. It still counts toward the per-asset cap (1 + 2 regenerations), the same
  bounded-reroll rule as the lab's own handoff (original seed + 2 extra).
- **Down:** an unreachable lab, or a non-2xx probe, is `ProviderUnavailable`. art_generate falls back to
  pixellab once (`fallback_from: "comfy"`). It is never persisted as exhausted: the next call probes again.
  A timeout names the `prompt_id` (the job may still finish in the lab's queue; nothing is billed).
- **License caveat:** Nova Pixels XL's creator requires edits before commercial use. Any game sold
  with comfy assets needs them edited first (`docs/decisions.md`).

## Cost policy

Every generation returns `cost_micro_usd` and `cost_source: "reported" | "estimated"` (`"local"` and 0 for comfy).
Reported beats estimated; a paid call never reports 0 (an estimate is used instead).
A failed submit is charged at the estimate unless the provider answered 4xx or the connection
never carried the request (refused, DNS, unreachable): a reset, abort, timeout, 5xx, or a 2xx with
no job id may have left a billed job behind, so it is charged (it can overcount an auto-refunded 5xx).
This spend is **budget-capped like inference** (per-agent period caps in the spec, global
daily cap in the runner), not per-call approved — recorded in `docs/decisions.md`.

## Credits (T19): free-trial tiers, never purchased

Both accounts are free trials and nobody adds money; no billing or purchase endpoint is ever
called. The `art_generate` capability (runner/tools/impl.ts over tools/art/credits.ts):
- **Exhausted**: a 402 (or `not_enough_balance`) is `ProviderExhausted` — uncharged, never
  retried — and is recorded in `runs/art-providers.json` (`{provider: {exhausted, ts,
  remaining_balance, reason}}`, atomic write, `ART_PROVIDERS_FILE` overrides). Exhausted
  providers are refused without a request until a human runs `npm run art -- providers --clear <p>`.
- **Fallback**: an exhausted provider → the other one, once, same prompt/size (`fallback_from`
  in the result; PixelLab cannot take an animation fallback). Both gone →
  `{exhausted: "all", fallback: "procedural"}` at zero cost: the Art Director's ladder floor.
- **Conserve**: bake-offs are for anchors; `art_anchor_winner` records the winner in
  `runs/art-gallery.json` and calls that reference the anchor default to it (the loser is
  refused). One generation + 2 regenerations per asset (counted in the gallery by the normalized out path, slot
  reserved before the paid call and released if it billed nothing, so concurrent calls can't overshoot; T39). A redo past
  the cap needs a human: a NEW out path (`<name>-v2.png`) is the default; keeping the path takes an operator-approved
  `art_redo` (approval-only capability) or `npm run art -- redo <out> --why …`, which grants one fresh allowance (ledgered).
  Before any paid call art_generate refuses an `out` with no real file name or outside `game/assets/`, and a postprocess
  whose manifest or manifest entry (size for snap, grid+palette for snap/lock) is missing, with zero requests. comfy is
  never refused by an anchor's bake-off winner (the lock is among paid providers). Animation
  (frames, `rd_animation__*`, `rd_advanced_animation__*`) needs `justify`. `art_quote` returns
  RD's free check_cost quote (PixelLab: price table) × count against the remaining balance.
- **PixelLab floor (T35, `PIXELLAB_MIN_REMAINING`)**: PixelLab is ONE generations balance shared by every
  studio, so a reserve is enforced in code, not by people watching. With the env set (integer generations),
  art_generate reads the live balance (free `GET /v2/balance`, no cache) before EVERY pixellab call, regens and
  animations included. It refuses the call, with no PixelLab request, when `remaining <= floor` or when
  `remaining - estimate < floor` (the call itself would cross it). `estimate` = the most generations one pixellab
  call has used in `art-credits.jsonl` (T21 `generations_used`), else 30. A balance that can't be read fails
  closed while the floor is set. A USD (credits, not subscription) balance is outside the floor. A refused call
  is treated like an exhausted provider for that call only: comfy next (stills, if the lab answers), then the
  rest of the chain, then `{exhausted: "all", fallback: "procedural"}`. The result carries `pixellab_floor`
  ({reason at_floor | would_cross | unreadable, remaining, floor, estimate}) and says "PixelLab floor reached
  (remaining R <= MIN): use provider comfy with your reference image, or stop and report". It is never written
  to art-providers.json (the floor is per studio and the balance can rise); only a real 402 marks pixellab
  exhausted. ONE ledger decision per day (topic `spend.pixellab_floor`, refs `pixellab-floor:<day>`). A
  malformed value is an error on every call, never a silently missing floor.
- **PixelLab subscription (T21)**: art_generate reads the free balance before and after every
  PixelLab call and reports `generations_used` (the delta) in the result and in art-credits.jsonl.
  Generation balances use absolute thresholds: ONE ledger note at <= 400 remaining and one at 0
  (per day). USD balances keep the 20%-of-first-reading / 0 rule. `max_candidates` (default 4,
  max 8) caps the images kept per call. Extras are discarded before decoding, download, or write.
  It keeps the gallery reviewable but does not save generations: the provider bills what it made.
- **Visibility**: every reported balance (RD `remaining_balance`; PixelLab `GET /v2/balance`
  after a generation) goes to `runs/art-credits.jsonl` (ts, provider, remaining, unit, total,
  generations_used, run_id, source)
  and into the result. Below 20% of the day's first reading, and at 0, ONE ledger decision per
  threshold per provider per day (topic `art.credits_low`, deduplicated by its `refs` key).
