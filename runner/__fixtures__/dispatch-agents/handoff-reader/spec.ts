import { z } from "zod";
import { defineAgent } from "../../../spec.ts";
// T48 fixture: depends on a writer card and reads its files with workspace_read.
export default defineAgent({ name: "handoff-reader", description: "Fixture: reads upstream files handed in.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  tools: { workspace_read: "allow" },
  output_schema: z.object({ answer: z.string() }) });
