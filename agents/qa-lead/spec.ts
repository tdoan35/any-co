import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// The release gate. Every claim carries evidence: a command that was run, a file path, an
// event tick. Verdicts are computed against the contracts in docs/contracts/.
export default defineAgent({
  name: "qa-lead",
  description: "QA: runs the contract test layers (engine tests, autoplay campaigns, state/event checks), triages findings by severity, and owns the release verdict.",
  dept: "qa",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 5, max_task_usd: 1, period: "day" },
  tools: { game_repo: "allow", qa_harness: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      complete: COMPLETE,
      verdict: z.enum(["pass", "fail", "blocked"]).describe("blocked = the layers you were asked to run couldn't run (build broken, no clone, missing artifacts)"),
      build_id: z.string().max(60).describe("The dist/build_id this verdict covers, exactly; 'none' if no build"),
      layers: z
        .array(
          z
            .object({
              layer: z.enum(["engine-tests", "autoplay", "visual", "data-schemas", "exploratory"]),
              status: z.enum(["ran", "skipped", "blocked"]),
              detail: z.string().min(5).max(400).describe("What ran: commands, seeds, counts — copied from game_exec output"),
            })
            .strict(),
        )
        .min(1)
        .max(5),
      invariants: z
        .array(
          z
            .object({
              check: z.string().min(5).max(150).describe("e.g. 'no negative resources in any state dump'"),
              result: z.enum(["held", "violated", "not-checked"]),
              evidence: z.string().max(300).describe("The dump, event, or command output that shows it"),
            })
            .strict(),
        )
        .min(3)
        .max(10),
      findings: z
        .array(
          z
            .object({
              severity: z.enum(["blocker", "major", "minor"]),
              what: z.string().min(10).max(300),
              evidence: z.string().min(5).max(300).describe("Repro: seed, policy, tick, and where the artifact lives"),
              suspected_cause: z.string().max(200).optional(),
            })
            .strict(),
        )
        .max(12),
    })
    .strict(),
  limits: { max_turns: 40, max_output_tokens: 12288 },
});
