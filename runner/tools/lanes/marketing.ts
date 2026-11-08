// Capability lane: Marketing & Distribution. Owner: Joyce (agents/marketing-lead, agents/community-outreach,
// new marketing agents, tools/marketing/**, docs/marketing/**).
// Rules (enforced at load and in spec validation; see runner/tools/README.md):
//   - Names are new: a lane can't redefine a core or another lane's capability, or shadow any tool name.
//   - No default grants: an agent gets a capability only by naming it in its spec's `tools`.
//   - Anything that sends or spends outside the studio (posts, uploads, emails, paid APIs) is declared
//     `outward: true`, and spec validation then refuses "allow": grant it as "ask" (approval gate + ledger).
//   - Import helpers from ../kit.ts (and tools/**), never from ../impl.ts or ../registry.ts (load cycle).
//   - Every tool ships with a test (tools/marketing/** or runner/tools/lanes/marketing.test.ts).
import type { LaneImpls } from "./types.ts";
import type { Capability } from "../registry.ts";
import { tiktokUpload, youtubeUpload } from "../../../tools/marketing/social.ts";

export const CAPABILITIES = {
  youtube_upload: {
    summary: "Upload one mp4 to the studio YouTube channel. Dry-run by default; a real upload needs dry_run:false and the operator's approval.",
    naive: ["bash"],
    local: true,
    outward: true,
    note: "Env: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN. The description must contain STUDIO_DISCLOSURE before a real upload. Keys never appear in results.",
  },
  tiktok_upload: {
    summary: "Package one mp4 for a TikTok post. Dry-run records the package; a live post is refused.",
    naive: ["bash"],
    local: true,
    outward: true,
    note: "Unaudited TikTok clients can only post private, and app review will not finish before the freeze. The tool never calls TikTok.",
  },
} as const satisfies Record<string, Capability>;

export const IMPLS: LaneImpls<typeof CAPABILITIES> = {
  youtube_upload: { youtube_upload: youtubeUpload },
  tiktok_upload: { tiktok_upload: tiktokUpload },
};
