import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

const unit = z.number().min(0).max(1);
const scored = z.object({ score: unit.describe("1 = easy for this studio, 0 = not buildable"), why: z.string().min(15).max(300) }).strict();

const Review = z
  .object({
    working_title: z.string().describe("The pitch's working_title, exactly"),
    scores: z
      .object({
        animation_load: scored,
        scope_fit: scored.describe("Can the must list ship in a one-day build?"),
        systems_complexity: scored,
        content_volume: scored,
        tech_risk: scored.describe("Engine, web export, performance, pathfinding, physics, save systems"),
        ui_complexity: scored,
      })
      .strict(),
    must_hours: z
      .array(z.object({ item: z.string().describe("A scope.must[].item, exactly"), hours: z.number().min(0).max(40) }).strict())
      .min(1)
      .describe("Agent-engineering hours for every scope.must item (wiring in art and self-testing included; art production and QA excluded)"),
    attacks: z
      .array(
        z.object({
          severity: z.enum(["blocker", "major", "minor"]),
          target: z.string().describe("The pitch field attacked, as a path from the pitch root, e.g. 'scope.must[2]', 'scope.should[0]', 'animation_budget', 'hook'"),
          claim: z.string().min(20).max(300),
          fix: z.string().max(250).describe("The cut or change that would answer it, or 'none' for a blocker you think can't be fixed"),
        }).strict(),
      )
      .min(2)
      .max(8),
    strongest_point: z.string().max(250).describe("What is genuinely good about this pitch"),
  })
  .strict();

export default defineAgent({
  name: "feasibility-critic",
  description: "Greenlight: attacks each pitch's buildability for a one-day agent build; scores it and proposes cuts. The veto is computed in code.",
  dept: "greenlight",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 0.5, period: "day" },
  tools: { catalog_query: "allow" },
  output_schema: z.object({ reviews: z.array(Review).min(1).max(5), ranking_note: z.string().max(600) }).strict(),
  limits: { max_turns: 15, max_output_tokens: 16384 },
});
