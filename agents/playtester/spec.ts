import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// The player proxy: drives the game through the contracts, reads states/events, and reports
// what a human would feel — confusion, dead time, unfair deaths. No vision tool yet, so
// visual claims cite screenshot paths, not pixels.
export default defineAgent({
  name: "playtester",
  description: "QA: plays the game through autoplay policies and scripted inputs; reports bugs with repro, confusion points, and where it stops being fun.",
  dept: "qa",
  runner: "local",
  model: "z-ai/glm-5.3",
  // Nov 7 6 PM: Neon credits ran out, so this agent is on GLM-5.3 through Naïve's proxy (real money; the cheaper model
  // where quality allows, Ty via EA B). The proxy rejects image blocks, so no image_view: decisions use art_gate numbers.
  budget: { cap_usd: 25, max_task_usd: 4, period: "day" },
  tools: { game_repo: "allow", qa_harness: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
      complete: COMPLETE,
      runs: z
        .array(
          z
            .object({
              seed: z.number().int(),
              policy: z.string().max(60),
              ticks: z.number().int(),
              outcome: z.string().max(40).describe("From the run_end event / run_summary, exactly"),
              death_cause: z.string().max(60).nullable(),
              anomalies: z.array(z.string().max(200)).max(5).describe("Odd states/events noticed, with tick numbers"),
            })
            .strict(),
        )
        .min(2)
        .max(10),
      bugs: z
        .array(
          z
            .object({
              severity: z.enum(["blocker", "major", "minor"]),
              what: z.string().min(10).max(300),
              repro: z.string().min(5).max(300).describe("seed + policy + ticks to see it again"),
            })
            .strict(),
        )
        .max(10),
      confusion_points: z
        .array(z.object({ where: z.string().max(80), why: z.string().min(10).max(250) }).strict())
        .max(6)
        .describe("Places a new player would be lost: menus, first minute, unexplained rules"),
      fun_signals: z
        .object({
          summary: z.string().min(30).max(500).describe("Where it engaged and where it sagged, from run lengths, picks, death causes"),
          evidence: z.array(z.string().max(200).min(5)).max(6).describe("Telemetry facts that back the summary"),
        })
        .strict(),
      suggestions: z.array(z.string().max(200)).max(5).describe("Smallest changes that would most help; the Director decides"),
    })
    .strict(),
  limits: { max_turns: 90, max_output_tokens: 12288 }, // Nov 8: last run used all 60 turns
});
