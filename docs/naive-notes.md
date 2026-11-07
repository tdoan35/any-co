# Naïve platform notes

Collected from the docs on Nov 3–4, 2026; naming and SDK details re-checked Nov 6.
Re-check https://usenaive.ai/docs/llms.txt when in doubt (`vetta.sh/docs` redirects there).

## Naming
- Product is **Naive Managed Agents**. SDK `@usenaive-sdk/managed-agents` (renamed from
  `@usenaive-sdk/vetta`; same exports, swap the import). CLI is `naive`. API host is still
  `https://api.vetta.sh`; the completion window header is still `Vetta-Window`.
- SDK `@usenaive-sdk/managed-agents@0.12.1` installed. Client namespaces include agents, board,
  sessions, proxy, models, files, computers, deployments, apps, skills, credits, social, emails,
  mobileDevices, browser, stream. Health check: `npm run naive:check`.
- SDK is ESM-only. `createClient({ baseUrl, apiKey })`; key sent as `Authorization: Bearer`.
  Docs examples read the key from `NAIVE_API_KEY` (we use that name in `.env`).
- Every non-2xx throws `ApiError { status, type, code, param, requestId }`.
- All money is **integer micro-USD** (1 USD = 1,000,000).

## Agents
- Fields: `name`, `system` (the prompt), `model`, `harness` (default `pi`), `tools`,
  `mcp_servers`, `skills` (slugs), `budget` (required), `window`, `output_schema` (JSON Schema
  the final result must satisfy). Tools are gated `allow` / `ask` / `deny`.
- Every edit makes a new immutable version: `agents.create/update/get/list/listVersions/rollback/spend`.
- Tool-definition shape for `tools`: see `capabilities/tools.md` (not yet read).

## Budgets
- `budget: { cap_micro_usd, max_task_micro_usd, period: "day" | "week" | "month" }`, all required.
  `max_task_micro_usd` ≤ `cap_micro_usd`.
- Sessions: `budget_micro_usd` on create, `sessions.setBudget(id, cap)`; can't exceed the
  agent cap, can't be removed. Default is the agent's `max_task_micro_usd`.
- Every priced call is quoted pre-flight and refused with `budget.exceeded`; a capped session
  goes `budget_paused` and resumes when the cap is raised.
- Spend: `naive agent spend <id> --by component`, `GET /v1/agents/{id}/spend`.

## Direct inference (what the local runner uses)
- `client.proxy.messages(body, window?)` → `POST /v1/proxy/anthropic/v1/messages`.
  Anthropic Messages shape: `model`, `messages`, `max_tokens` (required; sets the pre-flight
  quote), `system`, `tools: [{ name, description, input_schema }]`. Returns `tool_use` blocks;
  we run tools and send `tool_result`. **Not accepted:** `temperature`, `top_p`,
  `stop_sequences`, `thinking`.
- `client.proxy.completions(body, window?)` → OpenAI chat-completions shape.
- No streaming methods on `proxy`; for streaming, point an Anthropic/OpenAI client at
  `<baseUrl>/v1/proxy/anthropic` or `/v1/proxy/openai`.
- Reply has `id` (= request id, ledger key), `model`, `resolved_model`, `content`,
  `stop_reason`, token `usage`. **No cost on the reply.** Verified Nov 6:
  `client.proxy.call(reply.id)` returns `billed_micro_usd` immediately (plus provider,
  duration, usage split incl. `reasoning`). `credits.ledger({limit})` shows the debit with
  five-tier `line_items`. `credits.show()` → `{ balance_micro_usd, mode }`.
- Reasoning models spend hidden reasoning tokens inside `max_tokens` (a 1-word reply used 35
  output tokens on glm-5.3-flash), so don't set `max_tokens` tight.
- Measured: glm-5.3-flash ~1.2–1.5 s round trip for a tiny call, 20 micro-USD.

## Models
- Live catalogue: `client.models.list({ search, window, limit, after })`, `naive models list`.
  No prices published. 376 models on Nov 6, incl. `anthropic/claude-{opus,sonnet,haiku}-5.5`,
  `openai/gpt-6-*`, `google/gemini-3.x`, `moonshotai/kimi-k3*`, `z-ai/glm-5.3*`, `qwen/qwen3.8*`,
  `x-ai/grok-4.x`. `:batch` suffix variants and `~vendor/…-latest` aliases also exist. Example ids: `z-ai/glm-5.3-flash`, `zai-org/GLM-5.2-FP8`,
  `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it`, `deepseek/deepseek-v4-flash-0731`,
  `openai/gpt-oss-120b`, `vetta/auto` (router, `immediate` only).
- Completion windows: `immediate` (default, priciest), `priority`, `loose` (cheapest). Only
  GLM-5.2-FP8, Kimi-K2.6, and gemma-4-31B support priority/loose; others return
  `window_unavailable` (400, no spend). Precedence: session > agent > org default.

## Teams
- A team is a coordinator agent with a roster. **Flat: one level.** A roster can't contain
  another coordinator. **Max 20 agents** per roster.
- Two patterns: delegation (point to point) and the board (durable cards that start sessions).
- **One card per agent at a time.** Parallel work needs more agents.
- Board statuses: `todo`, `doing`, `blocked`, `done`. Closing a card requires a note.
  Cards support `blocked_by` dependencies; use them for lead/worker ordering.
- Hierarchy is by convention: leads own areas via card routing. A nested tree can run
  inside one node (e.g. local engineering loop behind one roster slot).

## Approvals
- Tools for spend, publish, and file actions ask for approval by default. Those `ask`
  approvals exist only in Naïve's harness; the local runner needs its own gate.

## Files
- `files.upload(FormData)` ≤ 25 MiB; `files.createUpload({ name, content_type, size_bytes })`
  → PUT to `upload_url` within 15 min, ≤ 60 MiB; `files.import({ url })`.
- `files.download(id)` is text-only (mangles binary); use `files.downloadBytes(id)`.
- In sessions, reference file ids in the first message; the agent's `fetch_file` copies them
  into the sandbox and `publish_file` moves output into Files (≤ 5 GiB).

## Tools from outside Naïve
- MCP endpoint `https://api.vetta.sh/v1/mcp` exposes the whole API as tools, named by route
  (e.g. `computers_exec_command`). The hosted harness uses names like `bash`, `browser`,
  `web_search`. Write prompts by capability, or add a shim mapping one set to the other.

## Other primitives in use
- **Computers:** sandboxes with shell and optional browser. Create one per worker and reuse it.
- **Deployments:** cron (e.g. Studio Head cycle every 2h).
- **Apps:** hosted web apps the agents deploy; optional Postgres; a fullstack app can serve an
  MCP endpoint offered to every agent (use for the ledger tools).
- **Mini apps:** dashboard pages built from platform blocks; can't show game-specific views.
- **Templates / blueprints:** `naive.config.ts`, applied with `naive up`. Packaging the studio
  this way supports a "Best Use of Naïve" pitch.

## Known gotchas
- **Bounded numbers in tool schemas are rounded to integers** (verified Nov 6, z-ai/glm-5.3 via
  `proxy.messages`): a property `{type: number, minimum: 0, maximum: 1}` returns 0.65 as `0`.
  Plain `{type: number}` is fine. The runner strips bounds from model-facing schemas
  (`modelSafeSchema` in `runner/run.ts`) and validates with zod. Hosted `output_schema` may be
  affected too: check before relying on it.
- `proxy.messages` rejects `tool_choice` (`unknown body field`).
- Data catalogue tools have strict, tool-specific inputs (unknown keys → 400). Google search
  returned 503 for a while on Nov 6; `web_search` falls back across three providers.
- Harness choice matters (pi / vetta / claude_code / hermes). A typed-output issue was
  reported on the `vetta` harness; verify structured output on the one you pick.
- Docs are inconsistent on whether SDK money fields are numbers or strings; examples use ints.
- **Email send exists but needs a provisioned identity** (checked Nov 7 in the SDK types):
  `client.emails.send(identityId, inboxId, { to: string[], subject, text })` sends from an
  inbox on a Naïve-verified domain and returns `{ accepted, from, to, sent_at }`. There is no
  `reply_to` in the send shape. The local `email_send` tool takes the identity/inbox ids from
  env (`NAIVE_EMAIL_IDENTITY_ID`, `NAIVE_EMAIL_INBOX_ID`) until the studio provisions them.
