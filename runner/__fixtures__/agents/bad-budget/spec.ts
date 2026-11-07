import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "bad-budget", description: "Fixture: task cap above period cap.", dept: "test", runner: "local",
  model: "m", budget: { cap_usd: 1, max_task_usd: 5, period: "day" } });
