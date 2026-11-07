import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Store copy, capsule brief, and trailer plan live in workspace files; this output is the
// positioning core, tag picks, and a manifest, so hand-offs route files and numbers stay checkable.
export default defineAgent({
  name: "marketing-lead",
  description: "Marketing: owns positioning and the hook; drafts Steam and itch store pages, tags, and the trailer plan from market data and player wants.",
  dept: "marketing",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 1, period: "day" },
  tools: {
    catalog_query: "allow",
    steam_reviews: "allow",
    web_search: "allow",
    web_fetch: "allow",
    workspace_read: "allow",
    workspace_write: "allow",
    studio_ledger: "allow",
  },
  output_schema: z
    .object({
      positioning: z
        .object({
          hook: z.string().min(20).max(250).describe("The one sentence that sells the game; what a 5-second GIF of it shows"),
          audience: z.string().min(20).max(300).describe("Who buys this, named by the comparables and communities they already play"),
          promise: z.string().min(20).max(300).describe("What the game delivers that the comparables don't, in the players' own words where possible"),
        })
        .strict(),
      tags: z
        .array(
          z
            .object({
              tag: z.string().min(2).max(60).describe("A Steam tag, exactly as it appears in catalog tool output"),
              evidence: z.string().min(10).max(250).describe("Why this tag is true of the game and helps discovery; cite catalog numbers where you have them"),
            })
            .strict(),
        )
        .min(3)
        .max(8),
      files: z
        .array(
          z
            .object({
              path: z.string().min(3).max(120).describe("Workspace path you wrote, e.g. store/steam-page.md"),
              kind: z.enum(["steam-page", "itch-page", "trailer-plan", "capsule-brief", "other"]),
              notes: z.string().max(250).describe("What the file contains and what it still needs"),
            })
            .strict(),
        )
        .min(2)
        .max(8),
      metrics: z.array(z.string().max(200)).max(5).describe("What to measure after each release step, and where the number is visible"),
      risks: z.array(z.string().max(200)).max(4).describe("Positioning risks: crowded tags, weak hook, promise the build can't keep"),
    })
    .strict(),
  limits: { max_turns: 40, max_output_tokens: 12288 },
});
