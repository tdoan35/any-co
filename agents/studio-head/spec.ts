import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "studio-head",
  description: "Head: the studio's coordinator. Talks with the operator, reports what the studio is doing, and logs its decisions.",
  dept: "head",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 3, max_task_usd: 0.25, period: "day" },
  // Read-only studio state, plus the decision ledger. No way to start agents or spend yet.
  tools: { studio_status: "allow", studio_ledger: "allow" },
  limits: { max_turns: 12, max_output_tokens: 4096 },
});
