import { z } from "zod";
import { COMPLETE, defineAgent } from "../../../spec.ts";
// Test double named like a real artist (T46): the dispatcher's art-merge hook keys on the agent name.
export default defineAgent({ name: "sprite-artist", description: "Fixture: an artist-named agent for the art-merge hook.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  output_schema: z.object({ complete: COMPLETE, summary: z.string() }).strict() });
