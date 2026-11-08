import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Second gameplay engineer (Nov 7, Ty via EA B): the board runs one card per agent, so a second spec lets two engineer
// cards run at once. Same prompt/tools/model; its own branch (agent/gameplay-engineer-b) and its own budget line.
// One ticket per task, own clone + branch, never merges. Self-test evidence is copied from
// game_exec output; QA re-runs it. (Roster runs two instances of this spec.)
export default defineAgent({
  name: "gameplay-engineer-b",
  description: "Eng: implements one gameplay ticket per task in its own clone and branch; self-tests against the contracts and hands the branch to the Tech Lead.",
  dept: "eng",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Local runs go through the Neon AI gateway (OpenAI-compatible): Eng may use non-Naïve inference (AGENTS.md).
  // Price = Anthropic list for Opus 5.5 ($4/$20 per MTok); Neon billing may differ, so spend is an estimate.
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 60, max_task_usd: 6, period: "day" }, // Opus via Neon; own day cap, separate from gameplay-engineer
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      ticket: z.string().min(3).max(120).describe("The ticket id/title from the task, copied exactly"),
      summary: z.string().min(20).max(600).describe("What you built and the design choices worth knowing"),
      files: z
        .array(z.object({ path: z.string().min(1).max(200), change: z.string().max(200) }).strict())
        .min(1)
        .max(20)
        .describe("Files changed in the clone, with a phrase on each change"),
      commits: z.array(z.object({ sha: z.string().min(7).max(40), message: z.string().max(120) }).strict()).min(1).max(10),
      self_test: z
        .array(
          z
            .object({
              command: z.array(z.string().min(1)).max(12).describe("Argv exactly as run via game_exec"),
              exit_code: z.number().int(),
              verdict: z.string().min(3).max(250).describe("What the output showed, not just the code"),
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .describe("At minimum: build.sh test, and the smoke that proves this ticket works"),
      questions: z.array(z.object({ for: z.string().max(40), question: z.string().min(10).max(300) }).strict()).max(5),
    })
    .strict(),
  limits: { max_turns: 50, max_output_tokens: 12288 },
});
