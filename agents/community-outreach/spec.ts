import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

// Targets and drafts first. Email sending exists as an ask-gated tool (email_send): the operator
// approves every send, and each decision lands in the approval queue and the ledger. Posting to
// venues has no send capability yet — those stay drafts for a human.
export default defineAgent({
  name: "community-outreach",
  description: "Marketing: finds where the game's players gather, checks each venue's self-promotion and AI rules, writes send-ready devlog posts and outreach messages, and sends approved email through the gated email_send.",
  dept: "marketing",
  runner: "local",
  model: "z-ai/glm-5.3",
  budget: { cap_usd: 4, max_task_usd: 0.75, period: "day" },
  tools: { web_search: "allow", web_fetch: "allow", workspace_read: "allow", workspace_write: "allow", studio_ledger: "allow", email_send: "ask" },
  output_schema: z
    .object({
      targets: z
        .array(
          z
            .object({
              name: z.string().min(2).max(80),
              kind: z.enum(["subreddit", "forum", "discord", "curator", "streamer", "press", "other"]),
              link: z.string().min(4).max(300).describe("URL you actually saw in search results or fetched"),
              audience_fit: z.string().min(10).max(250).describe("Why the people here are our players"),
              rules: z.string().min(4).max(300).describe("Self-promotion / AI-content rules that apply here, from the venue's own pages; 'unchecked' if you could not verify"),
            })
            .strict(),
        )
        .min(3)
        .max(10),
      drafts: z
        .array(
          z
            .object({
              path: z.string().min(3).max(120).describe("Workspace path you wrote, e.g. outreach/devlog-1.md"),
              kind: z.enum(["devlog", "post", "email", "comment"]),
              audience: z.string().min(3).max(120).describe("Which target(s) this draft is written for"),
            })
            .strict(),
        )
        .min(1)
        .max(8),
      cadence: z.string().min(40).max(400).describe("What to publish when across the weekend, tied to build milestones"),
      blocked: z.array(z.string().max(200)).max(4).describe("What needs a human approval or a missing capability before anything can be sent"),
    })
    .strict(),
  limits: { max_turns: 35, max_output_tokens: 12288 },
});
