import { z } from "zod";
import { COMPLETE, defineAgent } from "../../runner/spec.ts";

/** Headings docs/ui-spec.md must carry (`## <name>`); scripts/eval-ui-ux-designer.ts checks them in the clone. */
export const UI_SPEC_SECTIONS = ["Screen regions", "Visual hierarchy", "Panel style", "Type scale", "Spacing grid", "Genre conventions"] as const;
export const UI_SEVERITIES = ["blocker", "major", "minor", "polish"] as const;

// UI/UX review needs eyes on the exported build's frames. The Naïve proxy rejects image blocks, so this agent
// runs on OpenAI directly (T33, Ty's OpenAI budget). T33b, Ty's call: the gpt-6.1 tier. gpt-6.1-terra ("A fast,
// efficient model for visual reasoning, precise computer use…", input modalities text + image) at $1.00 in /
// $5.00 out per MTok (short context, developers.openai.com/api/docs/pricing, 2026-11-08), half of gpt-6.1-sol.
// "Tool calling requires the Responses API", so the provider speaks /v1/responses (api: "responses").
export default defineAgent({
  name: "ui-ux-designer",
  description: "Design: owns docs/ui-spec.md (regions, hierarchy, panel style, type scale, spacing, genre conventions) and reviews exported-build frames for severity-ranked UI findings.",
  dept: "design",
  runner: "local",
  model: "anthropic/claude-opus-5.5", // Naïve catalogue id, used only if this agent is ever hosted (the proxy rejects images)
  provider: {
    kind: "openai_compatible",
    model: "gpt-6.1-terra",
    api: "responses",
    base_url_env: "OPENAI_BASE_URL",
    base_url_default: "https://api.openai.com/v1",
    api_key_env: "OPENAI_API_KEY",
    usd_per_mtok: { input: 1, output: 5 },
  },
  budget: { cap_usd: 15, max_task_usd: 3, period: "day" },
  tools: {
    game_repo: "allow",
    qa_harness: "allow",
    media_capture: "allow",
    image_view: "allow",
    web_fetch: "allow",
    web_search: "allow",
    studio_ledger: "allow",
  },
  output_schema: z
    .object({
      complete: COMPLETE,
      spec: z
        .object({
          path: z.literal("docs/ui-spec.md"),
          sections: z.array(z.enum(UI_SPEC_SECTIONS)).describe("the required `## ` sections present in the file as committed"),
          commit: z.string().max(60).describe("the commit on your agent branch that holds this version of docs/ui-spec.md, or 'unchanged'"),
        })
        .strict(),
      build_id: z.string().max(60).describe("dist/build_id of the exported build the frames came from; 'none' if no build"),
      frames: z.array(z.string().max(200)).max(40).describe("workspace-relative paths of every frame you looked at with image_view"),
      findings: z
        .array(
          z
            .object({
              severity: z.enum(UI_SEVERITIES),
              frame: z.string().min(1).max(200).describe("workspace-relative path of the frame that shows it (one you viewed)"),
              element: z.string().min(1).max(80).describe("the UI element's id or name, as the spec or the scene names it"),
              rect: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()]).optional().describe("[x, y, w, h] in frame pixels"),
              problem: z.string().min(10).max(300),
              suggested_fix: z.string().min(10).max(300),
            })
            .strict(),
        )
        .max(20)
        .describe("severity-ranked, most severe first"),
      summary: z.string().max(400),
    })
    .strict(),
  limits: { max_turns: 40, max_output_tokens: 8192 },
});
