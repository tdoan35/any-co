import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Release step, after marketing-lead. Cuts and captions are workspace files. Uploads are ask-gated
// and dry-run by default (youtube_upload, tiktok_upload). Numbers in this output are copied from
// those tools and from media_probe.
const post = z
  .object({
    platform: z.enum(["youtube", "tiktok"]),
    caption_path: z.string().min(3).max(120).describe("Workspace path of the caption file, e.g. social/youtube.md"),
    cut_path: z.string().max(160).describe("Workspace path of the mp4, under media/; empty if you could not make one"),
    privacy: z.enum(["public", "unlisted", "private", "none"]).describe("The privacy you passed to the upload tool, or none if you did not call it"),
    rules: z.string().min(4).max(300).describe("What the platform's own page says about AI content and promotional uploads, or unchecked"),
    status: z.enum(["draft", "dry-run", "sent", "blocked"]),
    bytes: z.number().int().nonnegative().describe("Copied from the upload tool or media_probe; 0 if there is no file"),
    video_id: z.string().max(40).describe("YouTube id from the tool when status is sent; empty otherwise"),
    blocker: z.string().max(250).describe("Why it did not send, or empty when status is sent"),
  })
  .strict();

export default defineAgent({
  name: "social-media-manager",
  description: "Marketing: after the Marketing Lead, cuts release videos from the approved trailer plan and publishes them to YouTube and TikTok through approval-gated uploads.",
  dept: "marketing",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 6, max_task_usd: 2, period: "day" },
  tools: {
    game_repo: "allow",
    media_capture: "allow",
    image_view: "allow",
    workspace_read: "allow",
    workspace_write: "allow",
    studio_ledger: "allow",
    web_search: "allow",
    web_fetch: "allow",
    youtube_upload: "ask",
    tiktok_upload: "ask",
  },
  output_schema: z
    .object({
      cuts: z
        .array(
          z
            .object({
              path: z.string().min(3).max(160),
              format: z.enum(["mp4", "gif"]),
              duration_s: z.number().nonnegative().describe("Copied from media_probe"),
              bytes: z.number().int().nonnegative().describe("Copied from media_probe or the upload tool"),
            })
            .strict(),
        )
        .max(3),
      posts: z.array(post).length(2),
      files: z
        .array(
          z
            .object({
              path: z.string().min(3).max(120),
              kind: z.enum(["caption", "edit-plan", "other"]),
            })
            .strict(),
        )
        .min(1)
        .max(6),
    })
    .strict()
    .superRefine((out, ctx) => {
      const seen = new Set(out.posts.map((p) => p.platform));
      for (const need of ["youtube", "tiktok"] as const) {
        if (!seen.has(need)) ctx.addIssue({ code: "custom", message: `posts must include ${need}` });
      }
    }),
  limits: { max_turns: 40, max_output_tokens: 12288 },
});
