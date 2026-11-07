import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Spend numbers are copied from studio_spend output and re-checkable; rule claims cite URLs.
export default defineAgent({
  name: "finance-compliance",
  description: "Ops: tracks spend against budget and clears every external page and post against platform rules — Steam AI disclosure, asset licenses, venue self-promotion rules.",
  dept: "ops",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 3, max_task_usd: 0.5, period: "day" },
  tools: { studio_status: "allow", studio_ledger: "allow", web_search: "allow", web_fetch: "allow", workspace_read: "allow", workspace_write: "allow" },
  output_schema: z
    .object({
      spend: z
        .object({
          total_usd: z.number().min(0).describe("Copied exactly from studio_spend"),
          per_agent: z
            .array(z.object({ agent: z.string().min(2).max(60), usd: z.number().min(0) }).strict())
            .max(8)
            .describe("Copied from studio_spend, biggest first"),
          budget_status: z.enum(["on_budget", "watch", "over"]).describe("Against the caps given in the task; 'watch' when the trend reaches the cap before the freeze"),
          flags: z.array(z.string().max(200)).max(5).describe("Runaway agents, failed runs that still cost money, unusual patterns"),
        })
        .strict(),
      compliance: z
        .array(
          z
            .object({
              item: z.string().min(5).max(120).describe("What was checked, e.g. 'Steam AI-content disclosure on the store page draft'"),
              status: z.enum(["pass", "action-needed", "blocked", "not-ready"]).describe("'not-ready' = the thing being checked doesn't exist yet"),
              notes: z.string().min(5).max(300).describe("What you saw and where; rule checks cite the URL"),
            })
            .strict(),
        )
        .min(2)
        .max(10),
      actions: z
        .array(
          z.object({ action: z.string().min(5).max(200).describe("What must change before publish or send"), owner: z.string().min(2).max(40).describe("Agent or human who owns the fix") }).strict(),
        )
        .max(6),
    })
    .strict(),
  limits: { max_turns: 20, max_output_tokens: 8192 },
});
