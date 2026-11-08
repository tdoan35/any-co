import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// The content itself lives in workspace files (validated against the Game Design Director's schemas
// by QA); this output is only the manifest the studio routes and the balance rationale.
export default defineAgent({
  name: "level-content-designer",
  description: "Design: turns the design doc into content data files — levels, enemies, items, progression — balanced for a one-day build.",
  dept: "design",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 10, max_task_usd: 2.5, period: "day" }, // Nov 7: $0.75 hit wrap-up (70%) before the content write landed, three rounds running
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      complete: COMPLETE,
      files: z
        .array(
          z
            .object({
              path: z.string().min(3).max(120).describe("Path you wrote: game-repo path (e.g. content/enemies.json) when working in the game clone, else workspace path"),
              kind: z.string().min(3).max(40).describe("What this file holds, in the design doc's vocabulary"),
              entries: z.number().int().min(1).describe("Top-level entries in the file, counted from what you wrote"),
              notes: z.string().max(300).describe("What the entries cover and what was deliberately left out"),
            })
            .strict(),
        )
        .min(1)
        .max(12),
      balance: z
        .object({
          summary: z.string().min(40).max(800).describe("The knobs you tuned and the shape of the curves: early vs late difficulty, power vs cost, pace of unlocks"),
          risks: z.array(z.string().max(200)).max(5).describe("Where balance is most likely wrong, and what playtest data would show it"),
        })
        .strict(),
      questions: z
        .array(z.object({ for: z.string().max(40).describe("Agent that should answer, e.g. 'game-design-director'"), question: z.string().min(10).max(300) }).strict())
        .max(5)
        .describe("Schema gaps or design-doc contradictions blocking better content; empty if none"),
    })
    .strict(),
  limits: { max_turns: 60, max_output_tokens: 8192 },
});
