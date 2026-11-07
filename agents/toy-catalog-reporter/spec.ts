// Toy agent for exercising the runner end to end. Reports facts about the catalog dataset;
// produces no game content. Not part of the studio roster.
import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "toy-catalog-reporter",
  description: "Test agent: reads catalog metadata and reports dataset facts, to exercise the runner.",
  dept: "test",
  runner: "local",
  model: "z-ai/glm-5.3-flash",
  budget: { cap_usd: 1, max_task_usd: 0.05, period: "day" },
  tools: { catalog_query: "allow" },
  output_schema: z.object({
    snapshot_date: z.string().describe("ISO date the dataset ends"),
    tag_coverage_end: z.string().describe("YYYY-MM after which most releases lack tags"),
    window_releases_tagged: z.number().int(),
    caveats: z.array(z.string()).max(5),
  }),
  limits: { max_turns: 6, max_output_tokens: 4096 },
});
