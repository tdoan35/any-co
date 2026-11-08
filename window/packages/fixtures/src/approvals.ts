// Pending approval requests shaped exactly like window/server/weave.ts serves them (the "Input"
// preview row is the JSON input cut at 200 characters). Neutral placeholder values: no game content.
// art_signoff's input is a stand-in until the tool's real input shape lands.
import type { ApprovalItem } from "@fabric/contracts";

const AT = "2026-11-07T23:20:00.000Z";

/** Mirrors the adapter's mapping from an approvals.jsonl record to a Weave item. */
export function approvalFromRequest(r: { id: string; agent: string; run_id: string; tool: string; input: unknown; ts?: string }): ApprovalItem {
  return {
    id: r.id,
    kind: "approval",
    agentId: r.agent,
    project: "Studio",
    run: { label: r.run_id, href: `/runs/${r.run_id}` },
    title: `${r.agent} wants to run ${r.tool}`,
    brief: `${r.agent}'s ${r.tool}`,
    at: r.ts ?? AT,
    why: "This tool is gated behind a human approval (AGENTS.md rule 4). Approve or deny from the terminal: npm run approvals",
    tool: r.tool,
    policy: "approval",
    policyNote: "Asks before every call",
    preview: [
      { label: "Run", value: r.run_id },
      { label: "Input", value: JSON.stringify(r.input).slice(0, 200) },
    ],
    actions: [],
  };
}

const RUN = "20261107-160000-art-director";

/** Short enough to arrive whole. */
export const artSignoffApproval = approvalFromRequest({
  id: "apr-20261107232000-a1b2",
  agent: "art-director",
  run_id: RUN,
  tool: "art_signoff",
  input: { style_bible: "docs/style-bible.md", contact_sheet: "art/anchors/contact-sheet.png", grid: "32x32", palette: ["#202020", "#5a5a5a", "#a0a0a0", "#e8e8e8"] },
});

/** Over 200 characters: the adapter cuts it mid-array, so fields are salvaged. */
export const artSignoffTruncated = approvalFromRequest({
  id: "apr-20261107232500-c3d4",
  agent: "art-director",
  run_id: RUN,
  tool: "art_signoff",
  input: {
    style_bible: "docs/style-bible.md",
    contact_sheet: "art/anchors/contact-sheet.png",
    manifest: "assets/manifest.json",
    anchors: 12,
    grid: "32x32",
    palette: ["#101010", "#303030", "#505050", "#707070", "#909090", "#b0b0b0", "#d0d0d0", "#f0f0f0"],
  },
});

export const itchPushApproval = approvalFromRequest({
  id: "apr-20261108073000-e5f6",
  agent: "build-release",
  run_id: "20261107-233000-build-release",
  tool: "itch_push",
  input: { dir: "dist/web", target: "studio/game:html5", build_id: "b-0007", dry_run: false },
});

export const emailApproval = approvalFromRequest({
  id: "apr-20261108170000-0a1b",
  agent: "outreach",
  run_id: "20261108-090000-outreach",
  tool: "email_send",
  input: { to: "press@example.com", subject: "Placeholder subject", body: "Placeholder body.\nSecond line." },
});

/** A gated tool the window has no layout for: falls back to the adapter's own title. */
export const unknownToolApproval = approvalFromRequest({
  id: "apr-20261108010000-2c3d",
  agent: "tech-lead",
  run_id: "20261107-170000-tech-lead",
  tool: "some_new_gate",
  input: { reason: "placeholder" },
});

export const approvalFixtures = [artSignoffApproval, artSignoffTruncated, itchPushApproval, emailApproval, unknownToolApproval];
