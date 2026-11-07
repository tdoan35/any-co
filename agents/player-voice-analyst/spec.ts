import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

const unit = z.number().min(0).max(1);

// A claim about players, sized in code and backed by verbatim quotes. The eval re-runs the
// mention count and checks every quote against the cached review text.
const Finding = z
  .object({
    statement: z.string().min(10).max(200).describe("What players want, love, or can't stand, in plain words"),
    why_it_matters: z.string().min(10).max(300).describe("What this means for a new game in this segment"),
    sized_by: z
      .object({
        appid: z.number().int(),
        kind: z.enum(["negative", "positive"]),
        term: z.string().describe("The exact term passed to reviews_mentions"),
        share: unit,
        count: z.number().int(),
        sample_size: z.number().int(),
      })
      .strict()
      .describe("Copied exactly from one reviews_mentions result"),
    quotes: z
      .array(
        z.object({
          appid: z.number().int(),
          review_id: z.string(),
          quote: z.string().min(10).max(300).describe("Verbatim text from that review"),
        }).strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export default defineAgent({
  name: "player-voice-analyst",
  description: "Greenlight: reads Steam reviews of each gap's comparable games and reports unmet wants, loves, and deal-breakers, sized in code.",
  dept: "greenlight",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 1, period: "day" },
  tools: { steam_reviews: "allow", catalog_query: "allow" },
  output_schema: z
    .object({
      segments: z
        .array(
          z.object({
            gap_label: z.string().describe("The gap's label, as given in the task"),
            games_read: z
              .array(z.object({ appid: z.number().int(), name: z.string(), negative_read: z.number().int(), positive_read: z.number().int() }).strict())
              .min(1)
              .max(4),
            wants: z.array(Finding).min(1).max(5).describe("What players ask for that these games don't give them"),
            loves: z.array(Finding).min(1).max(4).describe("What a new game in this segment must keep"),
            deal_breakers: z.array(Finding).max(3).describe("What makes players quit or refund"),
            attention: z
              .object({
                summary: z.string().max(400),
                ratios: z.array(z.object({ appid: z.number().int(), last_6_vs_prior_6: z.number().nullable() }).strict()).max(4),
              })
              .strict()
              .describe("From reviews_trend: is attention on these games growing or fading?"),
          }).strict(),
        )
        .min(1)
        .max(6),
      cross_segment: z.array(z.string().max(500)).max(5).describe("Patterns that hold across segments, one or two sentences each"),
      method: z.string().max(800),
    })
    .strict(),
  limits: { max_turns: 45, max_output_tokens: 16384 },
});
