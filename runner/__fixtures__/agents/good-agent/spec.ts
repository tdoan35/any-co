import { z } from "zod";
import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "good-agent", description: "Fixture: a valid spec.", dept: "test", runner: "naive",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  tools: { web_fetch: "allow", workspace_read: "allow", workspace_write: "ask" },
  output_schema: z.object({ answer: z.string() }) });
