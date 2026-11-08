import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";
import { MUST_HOURS_BUDGET } from "../../tools/greenlight/feasibility.ts";

// Three pitches built from the Market Analyst's gaps and the Player Voice Analyst's findings.
// The design doc after the pick is the Game Design Director's job.
const Pitch = z
  .object({
    working_title: z.string().min(2).max(40),
    gap_label: z.string().describe("The Market Analyst gap this pitch targets, exactly as labeled in the task"),
    logline: z.string().min(20).max(200).describe("One sentence: what you do and why it's fresh"),
    player_fantasy: z.string().min(10).max(200),
    core_loop: z.array(z.string().max(120)).min(3).max(6).describe("The repeating steps of one session"),
    session_minutes: z.number().int().min(5).max(180).describe("Length of one run or session"),
    hook: z.string().min(20).max(250).describe("What a 5-second GIF of this game shows"),
    wants_addressed: z
      .array(z.object({ want: z.string().describe("The Player Voice finding's id from the task, e.g. \"W3\" (preferred), or its whole statement copied exactly. Never a shortened or reworded statement."), how: z.string().max(250) }).strict())
      .min(2)
      .max(4),
    loves_kept: z.array(z.string().max(200)).min(1).max(3).describe("Player Voice loves this pitch keeps"),
    comparables: z
      .array(z.object({ appid: z.number().int(), name: z.string(), relation: z.string().max(150).describe("'Like X, but Y'") }).strict())
      .min(2)
      .max(4),
    scope: z
      .object({
        must: z
          .array(z.object({ item: z.string().max(120), hours: z.number().min(0.25).max(10).describe("Agent-engineering hours, incl. wiring in art and self-testing the feature") }).strict())
          .min(3)
          .max(8)
          .describe(`Engineering work needed for a playable, shippable v1 (not art production or QA). Aim for ~7h; must total ${MUST_HOURS_BUDGET} or less.`),
        should: z.array(z.string().max(120)).max(6),
        could: z.array(z.string().max(120)).max(6),
      })
      .strict(),
    content_as_data: z.string().max(300).describe("What content is tables/data (cards, waves, items) rather than hand-made"),
    animation_budget: z
      .object({
        animated_characters: z.number().int().min(0).max(50).describe("Distinct characters or units that need animation"),
        frames_per_character: z.number().int().min(0).max(64),
        notes: z.string().max(250),
      })
      .strict(),
    price_usd: z.number().min(0).max(30),
    risks: z.array(z.string().max(200)).min(1).max(4),
    changes_from_review: z
      .array(z.string().max(300))
      .max(8)
      .describe("Revision mode only: each change made in answer to a Critic attack (name the target). Empty for a first draft."),
  })
  .strict()
  .refine((p) => p.scope.must.reduce((s, m) => s + m.hours, 0) <= MUST_HOURS_BUDGET, {
    message: `scope.must hours must total ${MUST_HOURS_BUDGET} or less: move items to should/could`,
    path: ["scope", "must"],
  });

export default defineAgent({
  name: "pitch-writer",
  description: "Game Design: during Greenlight, turns market gaps and player findings into three buildable pitches.",
  dept: "design",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 0.75, period: "day" },
  tools: { catalog_query: "allow" },
  output_schema: z
    .object({
      pitches: z.array(Pitch).length(3).describe("Three distinct pitches, your favorite first"),
      notes: z.string().max(1500).describe("How the three differ and what you'd want the Critic to test hardest"),
    })
    .strict(),
  limits: { max_turns: 20, max_output_tokens: 16384 },
});
