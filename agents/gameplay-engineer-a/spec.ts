import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// Gameplay Engineer A. One ticket per task, own clone + branch, never merges. Self-test evidence
// is copied from game_exec output; QA re-runs it. Engineer B is agents/gameplay-engineer-b.
export default defineAgent({
  name: "gameplay-engineer-a",
  description: "Eng: Gameplay Engineer A. Implements one gameplay ticket per task in its own clone and branch; self-tests against the contracts and hands the branch to the Tech Lead.",
  dept: "eng",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Nov 7 6 PM: Neon credits ran out ($0.99 left), so local runs go through Naïve's proxy (real money, billed per call). Ty via EA B.
  budget: { cap_usd: 80, max_task_usd: 15, period: "day" }, // Opus via Neon; one feature ticket per run; Engineer B has its own day cap
  tools: { game_repo: "allow", qa_harness: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      complete: COMPLETE,
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
  limits: { max_turns: 90, max_output_tokens: 12288 }, // Nov 8: the UI layout run used all 50 turns before committing
});
