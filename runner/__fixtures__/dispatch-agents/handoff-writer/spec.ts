import { z } from "zod";
import { COMPLETE, defineAgent } from "../../../spec.ts";
// T48 fixture: produces deliverables in its own workspace and names one inside the game clone.
export default defineAgent({ name: "handoff-writer", description: "Fixture: writes deliverables for a dependent card.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },
  output_schema: z.object({ complete: COMPLETE, files: z.array(z.object({ path: z.string() }).strict()), summary: z.string() }).strict() });
