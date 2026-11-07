import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "studio-head",
  description: "Head: the studio's coordinator. Talks with the operator, reports what the studio is doing, and logs its decisions.",
  dept: "head",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 3, max_task_usd: 0.25, period: "day" },
  // Board + studio state + the decision ledger. Cards are how work is assigned to agents;
  // the dispatcher (npm run studio) starts the assignee's run when the card is unblocked.
  // No spend and no outward sends yet: those wait on their gated capabilities.
  tools: { studio_status: "allow", studio_ledger: "allow", board: "allow" },
  limits: { max_turns: 12, max_output_tokens: 4096 },
});
