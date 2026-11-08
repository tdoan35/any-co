// Approval body for the studio's gated tools: how a pending request reads at a human checkpoint.
// Items come from @fabric/fixtures/approvals, shaped exactly like the adapter serves them
// (input cut at 200 characters). `live` shows the terminal commands, as in http mode.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { artSignoffApproval, artSignoffTruncated, emailApproval, itchPushApproval, unknownToolApproval } from "@fabric/fixtures/approvals";
import type { ApprovalItem } from "@fabric/contracts";
import { approvalTitle } from "@/lib/approval-gate";
import { ApprovalBody } from "./approval-body";

function Card({ item, live }: { item: ApprovalItem; live: boolean }) {
  return (
    <div className="min-h-screen bg-background/20 p-6">
      <article className="mx-auto max-w-[640px] space-y-4 rounded-2xl border border-foreground/10 bg-background/70 p-5 shadow-sm">
        <h2 className="text-lg font-semibold leading-snug tracking-tight">{approvalTitle(item)}</h2>
        <ApprovalBody item={item} live={live} />
      </article>
    </div>
  );
}

const meta = {
  title: "Weave/Approval body",
  component: Card,
  args: { item: artSignoffApproval, live: true },
  parameters: {
    layout: "fullscreen",
    // Same scoped exception as the other Weave files: muted text on translucent panels.
    a11y: { config: { rules: [{ id: "color-contrast", enabled: false }] } },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Checkpoint 1: the contact sheet gets the image slot, the palette shows as swatches, commands carry the id. */
export const ArtSignoff: Story = {
  name: "Art sign-off",
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("heading", { name: "Art sign-off" })).toBeInTheDocument();
    await expect(c.getByText("art/anchors/contact-sheet.png")).toBeInTheDocument();
    await expect(c.getByText("#a0a0a0")).toBeInTheDocument();
    await expect(c.getByText(`npm run approvals -- approve ${artSignoffApproval.id} --note ""`)).toBeInTheDocument();
    await expect(c.getByText(`npm run approvals -- deny ${artSignoffApproval.id} --note ""`)).toBeInTheDocument();
    await expect(c.getByRole("button", { name: "Copy approve command" })).toBeInTheDocument();
    await expect(c.queryByText(/first 200 characters/)).toBeNull();
  },
};

/** Long input: the adapter cut it, so complete fields are salvaged and the cut is said out loud. */
export const ArtSignoffTruncated: Story = {
  name: "Art sign-off · input cut at 200 chars",
  args: { item: artSignoffTruncated },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("art/anchors/contact-sheet.png")).toBeInTheDocument();
    await expect(c.getByText("assets/manifest.json")).toBeInTheDocument();
    await expect(c.getByText(/first 200 characters/)).toBeInTheDocument();
  },
};

/** Release checkpoint: a real push (dry run off) is flagged. */
export const ItchPush: Story = {
  name: "Release · itch push",
  args: { item: itchPushApproval },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("heading", { name: "Public release: itch.io push" })).toBeInTheDocument();
    await expect(c.getByText("Dry run")).toBeInTheDocument();
    await expect(c.getByText("no")).toBeInTheDocument();
  },
};

/** Outreach: the body keeps its line breaks. */
export const OutreachEmail: Story = { name: "Outreach email", args: { item: emailApproval } };

/** An unknown gated tool keeps the adapter's title and still lays out its input. */
export const UnknownTool: Story = {
  name: "Unknown gated tool",
  args: { item: unknownToolApproval },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("heading", { name: unknownToolApproval.title })).toBeInTheDocument();
  },
};

/** Mock mode (no adapter): no terminal commands or wait line. */
export const MockMode: Story = {
  name: "Mock mode · no commands",
  args: { live: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByText(/npm run approvals -- approve/)).toBeNull();
  },
};
