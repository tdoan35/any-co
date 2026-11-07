import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "other-name", description: "Fixture: name differs from folder.", dept: "test", runner: "local",
  model: "m", budget: { cap_usd: 1, max_task_usd: 1, period: "day" } });
