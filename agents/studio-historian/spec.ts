import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Facts come from studio tools: runs from studio_runs/studio_run, ledger counts from
// ledger_recent. Highlights cite their sources; nothing is invented.
export default defineAgent({
  name: "studio-historian",
  description: "Ops: keeps the studio's record — decisions, human interventions, build timeline — and turns it into the demo narrative.",
  dept: "ops",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 3, max_task_usd: 0.4, period: "day" },
  tools: { studio_status: "allow", studio_ledger: "allow", workspace_read: "allow", workspace_write: "allow" },
  output_schema: z
    .object({
      snapshot: z
        .object({
          runs: z.number().int().min(0).describe("Total runs, counted from studio_runs output"),
          total_spend_usd: z.number().min(0).describe("Copied exactly from studio_spend"),
          decisions_logged: z.number().int().min(0).describe("Counted from ledger_recent counts"),
          interventions: z.number().int().min(0).describe("Human interventions, counted from ledger_recent counts"),
        })
        .strict(),
      highlights: z
        .array(
          z
            .object({
              when: z.string().min(3).max(40).describe("Timestamp or run id, copied"),
              what: z.string().min(10).max(250),
              why_it_matters: z.string().min(10).max(200),
            })
            .strict(),
        )
        .min(3)
        .max(10)
        .describe("The moments that tell the studio's story: the pick, the cuts, the bugs, the saves"),
      files: z
        .array(
          z.object({ path: z.string().min(3).max(120).describe("Workspace path you wrote, e.g. demo/timeline.md"), kind: z.enum(["timeline", "narrative", "interventions", "other"]), notes: z.string().max(200) }).strict(),
        )
        .min(1)
        .max(5),
    })
    .strict(),
  limits: { max_turns: 15, max_output_tokens: 8192 },
});
