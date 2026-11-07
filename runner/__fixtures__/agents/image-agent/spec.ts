import { z } from "zod";
import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "image-agent", description: "Fixture: an agent that can view images.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  tools: { workspace_read: "allow", workspace_write: "allow", image_view: "allow" },
  output_schema: z.object({ answer: z.string() }) });
