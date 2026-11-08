// Capabilities an agent spec can grant. Specs name capabilities, not runner-specific tools,
// so one spec works on both runners (docs/naive-notes.md: "write prompts by capability").
//   naive: the Naïve built-in tools that provide it on the hosted harness.
//   local: whether the local runner implements it (runner/tools/impl.ts).
export interface Capability {
  summary: string;
  naive: string[];
  local: boolean;
  note?: string;
}

export const CAPABILITIES = {
  catalog_query: {
    summary: "Fixed queries over the Steam catalog (tools/catalog/query.py)",
    naive: ["bash", "read"],
    local: true,
    note: "Hosted agents need data/catalog.sqlite inside their computer; not set up yet.",
  },
  art_tools: {
    summary: "Deterministic art pipeline (tools/art): palette lock, grid snap, outline, strip split, contact sheet, asset gate",
    naive: ["bash", "read"],
    local: true,
    note: "Local tools over the run workspace and the game clone. Hosted setup not done.",
  },
  art_generate: {
    summary: "Paid pixel-art generation (tools/art/generate.ts): PixelLab or Retro Diffusion, prompt + size + optional reference/seed/frames, PNGs into the workspace, optional deterministic postprocess. Credit-aware (tools/art/credits.ts): exhausted providers fall back, then a procedural floor; anchor winners, regeneration cap, free quotes (art_quote), balances",
    naive: ["bash"],
    local: true,
    note: "Spend is budget-capped like inference (spec budgets + runner caps), not per-call approved. Free-trial credits, never purchased: state in runs/art-providers.json, art-credits.jsonl, art-gallery.json. Keys only from env; hosted setup not done.",
  },
  gap_map: {
    summary: "Embedding map of the Steam catalog: open regions near proven demand; probe a description (tools/gapmap)",
    naive: ["bash", "read"],
    local: true,
    note: "Needs data/gapmap/ built locally; probe uses OpenAI embeddings (~$0.000004/call). Hosted setup not done.",
  },
  steam_reviews: {
    summary: "Steam user reviews: cached samples, keyword mention rates, monthly trend (tools/steam-reviews)",
    naive: ["bash", "web_fetch"],
    local: true,
    note: "Scrapes public Steam Community review pages (~1 req/s, 7-day cache in data/reviews-cache). Hosted setup not done.",
  },
  studio_status: {
    summary: "Read-only view of the studio: recent runs and their outputs, spend, and the agent roster (runs/, agents/)",
    naive: [],
    local: true,
    note: "Local only: reads this repo's runs/. On Naïve the Studio Head would read the board and Files instead.",
  },
  studio_ledger: {
    naive: [],
    local: true,
    summary: "Studio decision ledger: log_decision, ledger_recent (tools/ledger)",
  },
  board: {
    summary: "The studio work board: create cards (assign work, blocked_by for order), read cards, comment (runner/board)",
    naive: ["board_read", "board_write"],
    local: true,
    note: "Hosted names from docs/team/board.md: board_read lists/reads, board_write does create/update/comment/assign. On the naive backend, local agent names never go in assignee (assignment wakes a hosted session); the runner keeps them in the card body header (runner/board/naive.ts).",
  },
  web_fetch: { summary: "Fetch a public URL as text", naive: ["web_fetch"], local: true },
  web_search: {
    summary: "Search the web",
    naive: ["web_search"],
    local: true,
    note: "Local runner uses the Naïve data catalogue's Search Google tool ($0.00015/call).",
  },
  workspace_read: { summary: "Read files in the agent's workspace", naive: ["read", "ls", "find"], local: true },
  workspace_write: { summary: "Write files in the agent's workspace", naive: ["write", "edit"], local: true },
  game_repo: {
    summary: "Work on the studio's game repo (games/<name>): clone into your run on an agent branch, read/write files, run commands (git, build.sh, engine CLI)",
    naive: ["bash", "read", "write", "edit"],
    local: true,
    note: "Local: per-run clone at runs/<id>/workspace/game, branch agent/<name>; only the Tech Lead merges. Hosted: the harness clones the repo into the agent's computer.",
  },
  qa_harness: {
    summary: "Run the QA contract driver on your game clone: qa_smoke / qa_check / qa_determinism (contract flags, invariants, verdict JSON)",
    naive: ["bash"],
    local: true,
    note: "Local: wraps tools/qa against <workspace>/game; argv-only launch command (godot or a path in the clone); timeouts mandatory. Read-only for the clone except its own qa/ outputs.",
  },
  media_capture: {
    summary: "Trailer/GIF/screenshot capture against docs/contracts (tools/media): stills by tick or event, engine movie mode, ffmpeg edit plans (mp4/GIF), ffprobe",
    naive: ["bash", "read"],
    local: true,
    note: "Local: launches the desktop build from the run's game clone (launch file inside the clone, or GODOT_BIN); needs ffmpeg/ffprobe on PATH (FFMPEG_BIN/FFPROBE_BIN). Outputs under the workspace's media/. Hosted setup not done.",
  },
  image_view: {
    summary: "Look at a PNG image from the workspace or game clone (art_view): the model sees the image itself, plus dimensions; optional integer upscale for tiny pixel art",
    naive: [],
    local: true,
    note: "Local only: sends an image block to the model; the PNG is copied content-addressed into the run dir. Hosted equivalent not set up.",
  },
  // ----- gated sends (T7): every send is ask-gated by the spec and ledgered via the approval gate -----
  itch_push: {
    summary: "Push a built dist/ channel to itch.io with butler (dry-run by default; a real push needs the operator's approval)",
    naive: ["bash"],
    local: true,
    note: "Env only: BUTLER_BIN (default butler) + BUTLER_API_KEY; butler reads the key from env, so it never appears in argv or results.",
  },
  itch_status: {
    summary: "Read-only butler status of an itch channel",
    naive: ["bash"],
    local: true,
    note: "Env only: BUTLER_BIN + BUTLER_API_KEY.",
  },
  email_send: {
    summary: "Send one outreach email from the studio's Naïve identity inbox",
    naive: [],
    local: true,
    note: "SDK emails.send: needs NAIVE_EMAIL_IDENTITY_ID + NAIVE_EMAIL_INBOX_ID in env; STUDIO_EMAIL_BLOCKLIST refuses addresses/domains. No reply_to in the SDK shape.",
  },
  site_deploy: {
    summary: "Publish the studio site (web build + marketing pages) to the studio's Naïve App; rollback to an earlier deployment",
    naive: [],
    local: true,
    note: "SDK apps.deploy: files go as path -> base64; needs STUDIO_SITE_APP_ID in env (app created once by the operator). Deployment builds async: poll site_status.",
  },
  site_status: {
    summary: "Read-only: the studio site's current deployment, URL, and history (last 5)",
    naive: [],
    local: true,
    note: "Needs STUDIO_SITE_APP_ID in env.",
  },
  art_signoff: {
    summary: "Human checkpoint before batch art: the operator approves or denies the anchor set (style bible + contact sheet) via the approval queue",
    naive: [],
    local: true,
    note: "Ask-gated: blocks in the approvals queue (T1). Grant art_signoff: 'ask' to art-director only. A denial returns its note as a normal result so the anchors get revised.",
  },
} as const satisfies Record<string, Capability>;

export type CapabilityName = keyof typeof CAPABILITIES;
