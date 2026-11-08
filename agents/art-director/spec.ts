import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// The director approves/rejects every asset using art_gate numbers and owns the style bible.
// Budget: generation is real money (RD Pro ~$0.18/image) — the director mostly gates and
// regenerates anchors when artists hit their caps, so $12/day with $4/task is enough for
// ~60 RD Pro regenerations a day while the daily spend cap still bites early on runaway loops.
export default defineAgent({
  name: "art-director",
  description: "Art: locks the style bible and manifest grid/palette before any generation, makes anchor sheets, approves or rejects every asset on art_gate numbers, runs the fallback ladder.",
  dept: "art",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Local runs on Opus 5.5 via the Neon gateway: the Naïve Messages proxy rejects image blocks (art_view, Nov 7),
  // and the OpenAI-compatible path carries tool images in a following user message (T8-fix). Price = Anthropic list (estimate).
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 30, max_task_usd: 8, period: "day" }, // Opus via Neon + art API spend
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", art_tools: "allow", art_generate: "allow", image_view: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      style_bible: z.string().min(3).max(200).describe("Repo path of the style bible (docs/style-bible.md)"),
      manifest: z
        .object({
          locked: z.boolean().describe("true once grid and palette are locked in assets/manifest.json"),
          grid: z.object({ w: z.number().int().min(1).max(512), h: z.number().int().min(1).max(512) }),
          palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(64),
        })
        .strict()
        .describe("Copied from the manifest you locked"),
      anchors: z
        .array(z.object({ id: z.string(), path: z.string().max(200), frames: z.number().int().min(1).max(64) }).strict())
        .max(8)
        .describe("Anchor sheets other sprites are generated from"),
      assets: z
        .array(
          z
            .object({
              id: z.string().max(60),
              path: z.string().max(200),
              pass: z.boolean().describe("art_gate's per-asset verdict, copied"),
              verdict: z.enum(["approve", "reject", "cut"]).describe("approve | reject (regenerate) | cut (fallback ladder)"),
              reason: z.string().min(3).max(300),
              offPaletteShare: z.number().min(0).max(1).describe("copied from art_gate numbers"),
              maxFrameDrift: z.number().min(0).max(1).nullable().describe("copied: max of art_gate frameDrift, null when one frame"),
              anchorDrift: z.number().min(0).max(1).nullable().describe("copied from art_gate numbers; null for anchors"),
            })
            .strict(),
        )
        .min(1)
        .max(64)
        .describe("One entry per manifest asset, every number copied from art_gate output"),
      regenerations: z.object({ calls: z.number().int().min(0).max(200), spent_usd: z.number().min(0).max(50) }).strict().describe("Totals from your art_generate calls this task"),
      notes: z.string().max(400),
    })
    .strict(),
  limits: { max_turns: 50, max_output_tokens: 12288 },
});
