import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "studio-head",
  description: "Head: the studio's coordinator. Talks with the operator, reports what the studio is doing, and logs its decisions.",
  dept: "head",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Nov 7: local runs on Opus 5.5 via the Neon gateway. On GLM-5.3 the plan-driven cycle spent its whole output limit
  // reasoning and returned nothing (20261107-164658); the head is the studio's planner, so it gets the reliable model.
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 30, max_task_usd: 1.5, period: "day" }, // 30-min cycles that create several cards per turn, Opus prices
  // Board + studio state + the decision ledger. Cards are how work is assigned to agents;
  // the dispatcher (npm run studio) starts the assignee's run when the card is unblocked.
  // No spend and no outward sends yet: those wait on their gated capabilities.
  tools: { studio_status: "allow", studio_ledger: "allow", board: "allow" },
  limits: { max_turns: 24, max_output_tokens: 8192 },
});
