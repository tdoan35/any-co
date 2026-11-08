import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "studio-head",
  description: "Head: the studio's coordinator. Talks with the operator, reports what the studio is doing, and logs its decisions.",
  dept: "head",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 12, max_task_usd: 0.6, period: "day" }, // Nov 7: 30-min cycles that create several cards per turn
  // Board + studio state + the decision ledger. Cards are how work is assigned to agents;
  // the dispatcher (npm run studio) starts the assignee's run when the card is unblocked.
  // No spend and no outward sends yet: those wait on their gated capabilities.
  tools: { studio_status: "allow", studio_ledger: "allow", board: "allow" },
  limits: { max_turns: 24, max_output_tokens: 4096 },
});
