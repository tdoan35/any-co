import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// Builds and staging are local work. Sends that leave the machine go through gated tools the
// operator approves one by one: itch_push (dry-run by default) and site_deploy (the studio site
// as a Naïve App, with rollback); every decision lands in the approval queue and the ledger.
// Steam uploads stay staged-only for now.
export default defineAgent({
  name: "build-release",
  description: "Eng: runs web and Windows builds through build.sh, stages every artifact, and ships it: itch pushes and studio-site deploys through operator-gated tools.",
  dept: "eng",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 4, max_task_usd: 1, period: "day" },
  tools: { game_repo: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow", web_fetch: "allow", itch_push: "ask", itch_status: "allow", site_deploy: "ask", site_status: "allow" },
  output_schema: z
    .object({
      complete: COMPLETE,
      build_id: z.string().min(1).max(60).describe("From dist/build_id, exactly"),
      builds: z
        .array(
          z
            .object({
              target: z.enum(["build-web", "build-windows"]),
              exit_code: z.number().int(),
              outputs: z.array(z.string().max(200)).min(1).max(10).describe("The paths build.sh reported"),
              size_kb: z.number().int().min(0).describe("Total size of the output dir, from du -sk"),
            })
            .strict(),
        )
        .min(1)
        .max(2),
      upload_staging: z
        .array(
          z
            .object({
              channel: z.enum(["itch-web", "itch-windows", "steam-windows", "studio-site"]),
              dist_path: z.string().max(200),
              status: z.enum(["ready", "sent", "blocked"]),
              command: z.string().max(300).describe("The exact command the operator would run for channels without a gated tool, or 'itch_push <dir> <target>' when it used the gated tool, or '' if blocked"),
              blocker: z.string().max(200).optional().describe("Why blocked: missing go-ahead, missing tool, missing page draft"),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      notes: z.string().max(500).describe("Build quirks, size worries, export warnings worth knowing"),
    })
    .strict(),
  limits: { max_turns: 30, max_output_tokens: 8192 },
});
