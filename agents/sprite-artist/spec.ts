import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Characters/enemies from the anchors: generation-heavy work. RD Pro reference-image runs
// are ~$0.18 each and animation retries are real, so $15/day with $5/task keeps a full
// character set with two animation attempts each inside one task's cap.
export default defineAgent({
  name: "sprite-artist",
  description: "Art: characters and enemies generated from the anchor sheets; cutout parts when model animation fails.",
  dept: "art",
  runner: "local",
  model: "z-ai/glm-5.3",
  // Nov 7 6 PM: Neon credits ran out, so this agent is on GLM-5.3 through Naïve's proxy (real money; the cheaper model
  // where quality allows, Ty via EA B). The proxy rejects image blocks, so no image_view: decisions use art_gate numbers.
  budget: { cap_usd: 40, max_task_usd: 12, period: "day" }, // Opus via Neon; PixelLab spend is in generations, tracked by art_generate
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", art_tools: "allow", art_generate: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      generated: z
        .array(
          z
            .object({
              id: z.string().max(60).describe("manifest id for this asset"),
              path: z.string().max(200).describe("workspace-relative PNG you produced"),
              provider: z.enum(["pixellab", "retrodiffusion"]),
              frames: z.number().int().min(1).max(64),
              in_manifest: z.boolean().describe("true once the manifest entry exists in the game clone"),
            })
            .strict(),
        )
        .min(1)
        .max(32),
      gate: z
        .object({ ok: z.boolean(), failed: z.array(z.string().max(60)).max(32) })
        .strict()
        .describe("Copied from your last art_gate run on the clone"),
      postprocess: z.object({ snap: z.boolean(), lock: z.boolean(), outline: z.boolean() }).strict().describe("What you chained after generation"),
      spent_usd: z.number().min(0).max(50).describe("Sum of cost_micro_usd from your art_generate calls, in USD"),
      notes: z.string().max(400),
    })
    .strict(),
  limits: { max_turns: 90, max_output_tokens: 12288 },
});
