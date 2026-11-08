import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Release step, after marketing-lead. Policy: docs/marketing/social.md.
// Video, photo, and text publish through Naïve Social. The lane upload tools are dry-run
// stand-ins for a video file, not the send. Skills load on a hosted session only.
const post = z
  .object({
    format: z.enum(["video", "photo", "text"]),
    platforms: z
      .array(z.enum(["youtube", "tiktok", "instagram", "x", "bluesky", "facebook", "linkedin", "mastodon", "threads"]))
      .min(1)
      .max(4)
      .describe("Networks this post targets. Instagram, TikTok, and YouTube require a media file"),
    caption_path: z.string().min(3).max(120).describe("Workspace path of the caption file"),
    media_path: z.string().max(160).describe("mp4 or still under media/; empty for a text post"),
    visibility: z.enum(["public", "unlisted", "private", "omit"]).describe("YouTube or Mastodon only. omit on any other network"),
    status: z.enum(["draft", "dry-run", "sent", "blocked"]),
    bytes: z.number().int().nonnegative().describe("Copied from media_probe or the upload tool; 0 for text"),
    post_id: z.string().max(80).describe("Id from social.post when status is sent; empty otherwise"),
    blocker: z.string().max(250).describe("Why it did not send, or empty when status is sent"),
  })
  .strict();

export default defineAgent({
  name: "social-media-manager",
  description: "Marketing: after the Marketing Lead, packages a release campaign in video, photo, and text and publishes it through Naïve Social. Sends wait for approval.",
  dept: "marketing",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 6, max_task_usd: 2, period: "day" },
  skills: ["naive/short-video-hooks", "naive/clip-selection", "naive/caption-writing", "naive/video-assembly"],
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
      posts: z.array(post).min(3).max(6),
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
      const seen = new Set(out.posts.map((p) => p.format));
      for (const need of ["video", "photo", "text"] as const) {
        if (!seen.has(need)) ctx.addIssue({ code: "custom", message: `posts must include a ${need} post` });
      }
    }),
  limits: { max_turns: 80, max_output_tokens: 12288 }, // Nov 8: the release photo run used all 40 turns (captures + staging)
});
