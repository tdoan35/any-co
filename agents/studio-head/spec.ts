import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "studio-head",
  description: "Head: the studio's coordinator. Talks with the operator, reports what the studio is doing, and logs its decisions.",
  dept: "head",
  runner: "local",
  model: "z-ai/glm-5.3",
  // Nov 7: Opus via Neon refused the cycle (finish_reason content_filter, 0 tokens) whenever the full studio state was in
  // context (ledger_recent + studio_agents together; no single entry); GLM's only failure was spending a 4k output limit
  // thinking, so it gets 16k and the runner now nudges an empty max_tokens reply.
  budget: { cap_usd: 12, max_task_usd: 0.6, period: "day" }, // 30-min cycles that create several cards per turn
  // Board + studio state + the decision ledger. Cards are how work is assigned to agents;
  // the dispatcher (npm run studio) starts the assignee's run when the card is unblocked.
  // No spend and no outward sends yet: those wait on their gated capabilities.
  tools: { studio_status: "allow", studio_ledger: "allow", board: "allow" },
  limits: { max_turns: 24, max_output_tokens: 16384 },
});
