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

export const CAPABILITIES = {
  // e.g. youtube_upload: { summary: "...", naive: ["bash"], local: true, outward: true, note: "Env: YOUTUBE_*" },
} as const satisfies Record<string, Capability>;

export const IMPLS: LaneImpls<typeof CAPABILITIES> = {};
