import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "bad-tool", description: "Fixture: unknown capability.", dept: "test", runner: "local",
  model: "m", budget: { cap_usd: 1, max_task_usd: 1, period: "day" }, tools: { teleport: "allow" } as any });
