import { z } from "zod";
import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "alpha-agent", description: "Fixture: dispatch target A.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  output_schema: z.object({ answer: z.string() }) });
