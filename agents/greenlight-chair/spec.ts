import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";
import { MUST_HOURS_BUDGET } from "../../tools/greenlight/feasibility.ts";

// Closes Greenlight: picks the game from the pitches that survived the Feasibility Critic and
// commits the studio to an engineering must list. The Studio Head reports the pick to the operator.
export default defineAgent({
  name: "greenlight-chair",
  description: "Greenlight: picks the game from the surviving pitches, commits to an engineering must list and Art/QA deliverables, and logs why.",
  dept: "greenlight",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 3, max_task_usd: 0.4, period: "day" },
  tools: { studio_ledger: "allow", catalog_query: "allow" },
  output_schema: z
    .object({
      pick: z
        .object({
          working_title: z.string().describe("A surviving (not vetoed) pitch's working_title, exactly"),
          why: z.string().min(80).max(1500).describe("Why this pitch beats the others: market evidence, player wants, buildability"),
          adopted_must: z
            .array(z.object({ item: z.string().describe("A must item, exactly as in the Critic's hour estimates"), critic_hours: z.number() }).strict())
            .min(2)
            .describe(`The engineering must list the studio commits to. Critic hours must total ${MUST_HOURS_BUDGET} or less.`),
          deferred: z.array(z.string().max(200)).max(8).describe("Engineering must items moved to should, and why in a few words"),
          art_and_qa: z
            .array(z.string().max(250))
            .min(2)
            .max(6)
            .describe("Commitments for the Art and QA teams (outside the engineering budget): what must be drawn, animated, and tested for v1"),
          conditions: z.array(z.string().max(250)).max(5).describe("Critic attacks the team must answer during the build"),
        })
        .strict(),
      rejected: z.array(z.object({ working_title: z.string(), why_not: z.string().min(20).max(500) }).strict()).min(1),
      risks_to_watch: z.array(z.string().max(250)).min(1).max(5).describe("What to check during the build; triggers for a scope cut"),
    })
    .strict(),
  limits: { max_turns: 10, max_output_tokens: 12288 },
});
