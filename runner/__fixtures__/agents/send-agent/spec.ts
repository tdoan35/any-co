import { z } from "zod";
import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "send-agent", description: "Fixture: gated send tools.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  tools: { email_send: "ask", site_deploy: "ask", itch_push: "ask" },
  output_schema: z.object({ ok: z.boolean() }) });
