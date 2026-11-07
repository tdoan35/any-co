import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";
import { MUST_HOURS_BUDGET } from "../../tools/greenlight/feasibility.ts";

// Design-doc mode (plan.md §5/§7): after the Chair's pick, the design itself is a file in the
// game repo (docs/design.md on the agent branch). The doc is the deliverable; this output is
// only the manifest plus numbers copied from the task and git, so the eval can check both.
export default defineAgent({
  name: "game-director-design",
  description: "Design: turns the Greenlight Chair's pick into the committed design doc (docs/design.md) — scope tiers, systems, data files, balance targets, art needs.",
  dept: "design",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Local runs on Claude Opus 5.5 via the Neon AI gateway (Ty: speed, Neon credits); price = Anthropic list (estimate).
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 20, max_task_usd: 5, period: "day" },
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow", catalog_query: "allow" },
  output_schema: z
    .object({
      branch: z.string().min(3).max(80).describe("Your agent branch from game_clone, e.g. agent/game-director-design"),
      commit: z.string().min(7).max(40).describe("The sha of the commit that adds docs/design.md, copied from git output"),
      doc_path: z.literal("docs/design.md"),
      must: z
        .array(z.object({ item: z.string().min(3).max(160), hours: z.number() }).strict())
        .min(1)
        .max(10)
        .describe("Copied exactly from the Chair's adopted_must: item and critic_hours"),
      should_count: z.number().int().min(0).max(20).describe("Rows in the Should table (the Chair's deferred items)"),
      could_count: z.number().int().min(0).max(20).describe("Rows in the Could table"),
      data_files: z
        .array(
          z
            .object({
              path: z.string().min(3).max(120).describe("Repo path the game will read, e.g. content/<name>.json"),
              what: z.string().min(3).max(120).describe("What the file holds, one phrase"),
            })
            .strict(),
        )
        .min(1)
        .max(12)
        .describe("Every data file the design declares under Content as data"),
    })
    .strict()
    .refine((o) => o.must.reduce((s, m) => s + m.hours, 0) <= MUST_HOURS_BUDGET, {
      message: `must hours must total ${MUST_HOURS_BUDGET} or less`,
      path: ["must"],
    }),
  limits: { max_turns: 30, max_output_tokens: 12288 },
});
