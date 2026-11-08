import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

// Marketing: vertical short-form clips (T50, Ty's direct ask). Briefs come from marketing-lead cards; real game footage via
// media_capture, plus Monid video endpoints (runner/tools/monid.ts, spend capped per studio per day). It never sends or
// posts: social-media-manager takes the clips (T48 hands the workspace on) and queues sends through the approval gate.
// Vision model: it judges its own clips and stills with art_view (GLM sees no images through the Naïve proxy).
const clip = z
  .object({
    path: z.string().min(3).max(160).describe("Workspace path of the finished mp4 under media/"),
    duration_s: z.number().min(15).max(45).describe("Copied from media_probe"),
    aspect: z.literal("9:16"),
    width: z.number().int().positive().describe("Copied from media_probe"),
    height: z.number().int().positive().describe("Copied from media_probe"),
    source_footage: z.array(z.string().min(3).max(160)).min(1).max(12).describe("Workspace paths of the real game footage/stills in this clip"),
    monid_run_ids: z.array(z.string().min(1).max(120)).max(10).describe("Monid runs used for this clip; empty when it is footage only"),
    cost_usd: z.number().nonnegative().describe("Sum of charged_usd from those Monid runs (monid_run / monid_run_get); 0 for footage only"),
    caption_path: z.string().min(3).max(160).describe("Its caption notes file under social/"),
  })
  .strict();

export default defineAgent({
  name: "short-form-video-producer",
  description: "Marketing: turns a Marketing Lead brief into vertical 9:16 clips (15-45 s) from real game footage plus Monid video tools, with caption notes and an AI disclosure. Never posts.",
  dept: "marketing",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // as the engineers (agents/gameplay-engineer-a): vision, through Naïve's proxy
  budget: { cap_usd: 18, max_task_usd: 6, period: "day" },
  tools: {
    game_repo: "allow",
    media_capture: "allow",
    image_view: "allow",
    monid: "allow", // a run estimated over MONID_APPROVAL_USD still waits for approval (approvalWhen)
    workspace_read: "allow",
    workspace_write: "allow",
    studio_ledger: "allow",
  },
  output_schema: z
    .object({
      complete: COMPLETE,
      clips: z.array(clip).min(1).max(4),
      caption_notes: z
        .array(
          z
            .object({
              clip: z.string().min(3).max(160).describe("The clip path these notes are for"),
              caption_path: z.string().min(3).max(160),
              ai_disclosure: z.string().min(10).max(200).describe("The disclosure line, copied from the caption file"),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      monid_spend_usd: z.number().nonnegative().describe("Total charged_usd across every Monid run this task, copied from tool results"),
      notes: z.string().max(600).describe("What the next card (social-media-manager) needs to know; blockers if any"),
    })
    .strict()
    .superRefine((out, ctx) => {
      const notes = new Set(out.caption_notes.map((n) => n.clip));
      for (const c of out.clips) if (!notes.has(c.path)) ctx.addIssue({ code: "custom", message: `clip ${c.path} has no caption notes` });
    }),
  limits: { max_turns: 60, max_output_tokens: 12288 },
});
