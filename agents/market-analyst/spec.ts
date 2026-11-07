import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";
import { enrichGaps } from "../../tools/greenlight/enrich.ts";

const unit = z.number().min(0).max(1);

const Gap = z
  .object({
    label: z.string().min(3).max(60).describe("Short name for the market segment, e.g. 'Tag A + Tag B'"),
    tags: z.array(z.string()).min(1).max(3).describe("Exact catalog tag names that define the segment"),
    thesis: z.string().min(40).max(700).describe("Why this is an underserved segment, citing the evidence"),
    comparables: z
      .array(z.object({ appid: z.number().int(), name: z.string(), reviews_total: z.number().int() }).strict())
      .min(2)
      .max(6)
      .describe("Real games from the catalog with these tags, copied from niche/games output"),
    concentration: z.string().max(300).describe("Is demand broad or carried by one or two breakout hits?"),
    momentum: z
      .object({
        direction: z.enum(["rising", "flat", "falling", "unknown"]),
        summary: z.string().max(500),
        sources: z.array(z.string().url()).max(5).describe("URLs you actually saw in search results or fetched"),
      })
      .strict(),
    feasibility: z.object({ score: unit, rationale: z.string().min(20).max(400) }).strict(),
    marketability: z.object({ score: unit, rationale: z.string().min(20).max(400) }).strict(),
    map: z
      .object({
        region_id: z.number().int().nullable().describe("The region you opened with gapmap_region and found this gap in; null if it came from tag stats (never copied from the probe)"),
        probe_text: z.string().min(20).max(600).describe("The exact text you passed to gapmap_probe for this gap (code re-probes it and adds the numbers)"),
      })
      .strict()
      .describe("Where this gap sits on the embedding map (required: probe every gap)"),
    risks: z.array(z.string().max(200)).max(4),
  })
  .strict();

export default defineAgent({
  name: "market-analyst",
  description: "Greenlight: finds underserved Steam market segments from catalog stats, the embedding gap map, and live trend checks; ranks gaps, makes no pitches.",
  dept: "greenlight",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 1, period: "day" },
  tools: { catalog_query: "allow", gap_map: "allow", web_search: "allow", web_fetch: "allow" },
  output_schema: z
    .object({
      gaps: z.array(Gap).min(5).max(8).describe("Your best gaps, best first"),
      data_caveats: z.array(z.string().max(300)).max(6),
      method: z.string().max(1500).describe("What you queried and how you chose, in a few sentences"),
    })
    .strict(),
  // Evidence (catalog niche stats) and map numbers are added by code after submission.
  postprocess: enrichGaps,
  limits: { max_turns: 50, max_output_tokens: 32768 },
});
