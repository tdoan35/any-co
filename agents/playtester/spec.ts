import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// The player proxy: drives the game through the contracts, reads states/events, and reports
// what a human would feel — confusion, dead time, unfair deaths. No vision tool yet, so
// visual claims cite screenshot paths, not pixels.
export default defineAgent({
  name: "playtester",
  description: "QA: plays the game through autoplay policies and scripted inputs; reports bugs with repro, confusion points, and where it stops being fun.",
  dept: "qa",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used if this agent is ever hosted
  // Nov 7: on GLM-5.3 the exploratory loop hit max_turns before reporting, and a human found a blank board the
  // state-only checks passed. Opus via Neon can image_view the screenshots it captures (the Naïve proxy rejects images).
  provider: { kind: "openai_compatible", model: "claude-opus-5-5", base_url_env: "NEON_AI_BASE_URL", api_key_env: "NEON_AI_API_KEY", usd_per_mtok: { input: 4, output: 20 } },
  budget: { cap_usd: 25, max_task_usd: 4, period: "day" },
  tools: { game_repo: "allow", qa_harness: "allow", workspace_read: "allow", workspace_write: "allow", image_view: "allow", studio_ledger: "allow" },
  output_schema: z
    .object({
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
  limits: { max_turns: 60, max_output_tokens: 12288 },
});
