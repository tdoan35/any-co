import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Two modes, one shape: skeleton mode (hour one) and merge mode. The output is always what
// shipped, where, and what the next agents can rely on — checked against the repo by QA.
const CONTRACTS = ["controls", "state-dump", "autoplay", "screenshot", "events", "asset-manifest", "telemetry", "build"] as const;

export default defineAgent({
  name: "tech-lead",
  description: "Eng: builds the Godot skeleton with all contracts and test hooks in hour one; the only agent that merges branches into the game's main branch.",
  dept: "eng",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Local runs go through the Neon AI gateway (OpenAI-compatible): Eng may use non-Naïve inference (AGENTS.md).
  // Price = Anthropic list for Opus 5.5 ($4/$20 per MTok); Neon billing may differ, so spend is an estimate.
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 60, max_task_usd: 15, period: "day" }, // Opus via Neon: a ~90-turn skeleton run is ~$5 at list price; Ty: spend the Neon credits
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow", web_search: "allow", web_fetch: "allow" },
  output_schema: z
    .object({
      commits: z
        .array(z.object({ sha: z.string().min(7).max(40), message: z.string().min(3).max(120), branch: z.string().min(1).max(80) }).strict())
        .min(1)
        .max(20)
        .describe("Commits on the game repo main branch this task (merge mode) or the skeleton commit(s)"),
      contracts: z
        .array(z.enum(CONTRACTS))
        .max(8)
        .describe("Contracts implemented and smoke-tested as of this output (docs/contracts/)"),
      build: z
        .array(
          z
            .object({
              target: z.enum(["build-web", "build-windows", "test", "qa"]),
              exit_code: z.number().int(),
              outputs: z.array(z.string().max(200)).max(10).describe("Paths the target produced, as build.sh reported"),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      tests: z.object({ passed: z.number().int().min(0), failed: z.number().int().min(0), notes: z.string().max(400) }).strict(),
      handoffs: z
        .array(z.object({ for: z.string().max(40).describe("Agent or role this enables"), what: z.string().min(10).max(250) }).strict())
        .max(6)
        .describe("What changed that other teams build on: schemas, hooks, build targets"),
      risks: z.array(z.string().max(200)).max(5),
    })
    .strict(),
  limits: { max_turns: 100, max_output_tokens: 12288 },
});
