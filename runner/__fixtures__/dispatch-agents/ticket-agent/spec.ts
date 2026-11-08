import { z } from "zod";
import { COMPLETE, defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "ticket-agent", description: "Fixture: ticket work that reports completion.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  output_schema: z.object({ complete: COMPLETE, summary: z.string() }).strict() });
