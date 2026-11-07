// Item detail stories (ANY-15 M4): the open inbox item — one direct-load story per kind,
// plus resolved (done / snoozed) detail states and the zero-actions edge.
//
// Kind → story inventory (all six user-visible kinds; none excluded):
//   approval (ungated) fetch-shard   → ApprovalDecision (decision + undo, play)
//   approval (gated)   email-priya   → GatedApprovalSnoozeByEvent (event snooze, play)
//   question           seed-count    → QuestionDecision (option-card decision, play)
//   escalation         nand-budget   → EscalationBudgetSpent
//   proposal           handoff-product → ProposalRoster
//   finding (open)     paper-350m    → FindingChallenges
//   finding (snoozed)  nand-datasets → SnoozedFindingUnsnooze (unsnooze, play)
//   result             report-135m   → ResultReportTable (mock API report, play)
//   any kind, no actions synthetic → EmptyActions (degrades to Snooze only)
//
// Documented exclusions:
//   - No "disabled action" state exists: components remove unavailable actions instead of
//     rendering disabled buttons, so the edge is "no actions" (EmptyActions) and resolved
//     states, where the whole action block is replaced by the resolved bar.
//   - Read/unread is a row-level affordance (dot + weight); the detail marks the item read
//     on open in the composed screen (see Inbox · keyboard flow), so no detail story varies
//     on unread.
//
// Every story mounts ItemDetail in the story router (RunChip/option links need it) against
// the resettable fixture world; prepare() seeds non-default statuses before first render.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed, type FindingItem } from "@fabric/fixtures/weave";
import { itemById, setWeaveSnapshot, useWeave, weave } from "@/lib/weave-store";
import { ItemDetail } from "./item-detail";

const meta = {
  title: "Weave/Item detail",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level like the other Weave/chat files: muted-foreground
      // text on translucent panels sits below the 4.5:1 bar — the same design tokens the
      // prior cards scoped out. Fixing means changing the design tokens, outside this
      // card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Reads the item from the (seeded) store so play-driven resolve/snooze re-render the
 * detail. prepare() runs synchronously before first render — after the harness reset —
 * so a story can start from a resolved or snoozed state without touching the fixtures.
 */
function DetailPane({ id, prepare }: { id: string; prepare?: () => void }) {
  useState(() => { prepare?.(); });
  const state = useWeave();
  const item = itemById(id);
  if (!item) return <p role="alert">{`Missing fixture item: ${id}`}</p>;
  return (
    <div className="min-h-screen bg-background/20 p-6">
      <ItemDetail item={item} st={state.status[id]} last={state.last} />
    </div>
  );
}

const detailRoutes = (id: string, prepare?: () => void) => ({
  router: { routes: [{ path: "*", element: <DetailPane id={id} prepare={prepare} /> }] },
});

// ---- approval (ungated: row-level quick actions exist, detail decides) ----

/** Ungated approval: tool + policy row, payload preview, and the decision flow. */
export const ApprovalDecision: Story = {
  name: "Approval · decide and undo",
  parameters: detailRoutes("fetch-shard"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The ask: what tool, under which policy, and the exact payload.
    expect(canvas.getByText("network.fetch")).toBeInTheDocument();
    expect(canvas.getByText("blocked")).toBeInTheDocument();
    expect(canvas.getByText("Only the package index and model host")).toBeInTheDocument();
    expect(canvas.getByText("data.commoncrawl.org/…/c4-validation-00003.json.gz")).toBeInTheDocument();
    expect(canvas.getByText("Why you're seeing this.")).toBeInTheDocument();

    // Three actions: primary/outline/ghost. Nothing is disabled — decide or snooze.
    expect(canvas.getByRole("button", { name: "Allow once" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Allow for this run" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Deny" })).toBeEnabled();

    // Deciding resolves the item: the actions are replaced by the outcome bar.
    await user.click(canvas.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(canvas.getByText(/^Allowed once/)).toBeInTheDocument());
    expect(canvas.getByText(/11:20 AM/)).toBeInTheDocument(); // pinned mock clock
    expect(canvas.queryByRole("button", { name: "Allow for this run" })).toBeNull();

    // …and the outcome bar still offers Undo, which restores the live actions.
    await user.click(canvas.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Allow for this run" })).toBeInTheDocument());
    expect(canvas.queryByText(/^Allowed once/)).toBeNull();
  },
};

// ---- approval (gated: human authority, event-based snooze) ----

/** Gated approval: no "always allow", the gate spelled out, snooze by agent event. */
export const GatedApprovalSnoozeByEvent: Story = {
  name: "Gated approval · snooze by event",
  parameters: detailRoutes("email-priya"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The gate: external send always asks, and the note says so — no autonomy options.
    expect(canvas.getByText("agentmail.send")).toBeInTheDocument();
    expect(canvas.getByText("approval")).toBeInTheDocument();
    expect(canvas.getByText(/Sending outside Fabric always asks/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Approve and send" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Don't send" })).toBeEnabled();

    // Option cards are only for consequential choices; this ask has none.
    expect(canvas.queryByText("Later today")).toBeNull();

    // The snooze menu carries the item's event-based options on top of the time ones.
    await user.click(canvas.getByRole("button", { name: "Snooze" }));
    const menu = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>("[role=menu]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(menu.textContent).toContain("When something happens");
    await user.click(within(menu).getByRole("menuitem", { name: "When Sana finishes her prep checks" }));

    // Snoozing resolves the detail into its snoozed state, with Unsnooze.
    await waitFor(() => expect(canvas.getByText("Snoozed · When Sana finishes her prep checks")).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: "Unsnooze" })).toBeInTheDocument();
  },
};

// ---- question (option cards with visible tradeoffs) ----

/** Question: context bullets, option cards carrying cost/ETA, ghost escape hatch. */
export const QuestionDecision: Story = {
  name: "Question · option-card decision",
  parameters: detailRoutes("seed-count"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText(/match the paper's two seeds, or run three\?/)).toBeInTheDocument();
    expect(canvas.getByText("The 135M result (−9.6% perplexity) was measured on two seeds.")).toBeInTheDocument();

    // Consequential options render as cards so the tradeoff is visible before picking.
    // (The card's accessible name carries its detail line, hence the prefix match.)
    const three = canvas.getByRole("button", { name: /^Run three seeds/ });
    expect(three).toBeInTheDocument();
    expect(canvas.getByText("~25 min longer · +$0.06 · ETA ~3:05 PM")).toBeInTheDocument();
    expect(canvas.getByText("ETA ~2:40 PM · Carlos may ask for a caveat")).toBeInTheDocument();

    // Deciding with an option card resolves the item with that option's outcome.
    await user.click(three);
    await waitFor(() => expect(canvas.getByText(/^Three seeds/)).toBeInTheDocument());
    expect(canvas.queryByRole("button", { name: /^Match the paper/ })).toBeNull();
  },
};

// ---- escalation ----

/** Escalation: spent rework budget as pips, and the escalation history with faces. */
export const EscalationBudgetSpent: Story = {
  name: "Escalation · budget spent",
  parameters: detailRoutes("nand-budget"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText(/Nothing more runs until you decide\./)).toBeInTheDocument();

    // The budget is readable non-visually and shows the pips amber.
    const pips = canvasElement.querySelector('[aria-label="2 of 2 used"]')!;
    expect(pips).not.toBeNull();
    expect(pips.querySelectorAll(".bg-warn")).toHaveLength(2);
    expect(canvas.getByText("2 / 2 spent")).toBeInTheDocument();

    // The escalation path, member → lead → Dana → you, with times.
    expect(canvas.getByText("Request changes: latency includes cache warm-up")).toBeInTheDocument();
    expect(canvas.getByText("Escalated to Dana: rework budget spent")).toBeInTheDocument();
    expect(canvas.getAllByText("10:38 AM")).toHaveLength(1);

    // Three ways out, each priced on its card (accessible names carry the detail line).
    expect(canvas.getByRole("button", { name: /^Raise budget to 3/ })).toBeEnabled();
    expect(canvas.getByText("One more attempt · ~40 min · ~$0.20")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /^Accept with a caveat/ })).toBeEnabled();
    expect(canvas.getByRole("button", { name: /^Stop the run/ })).toBeEnabled();
  },
};

// ---- proposal ----

/** Proposal: the roster with roles, and what crosses the boundary vs what stays. */
export const ProposalRoster: Story = {
  name: "Proposal · roster and boundary",
  parameters: detailRoutes("handoff-product"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText(/“Can these results drive a real, value-driven product\?”/)).toBeInTheDocument();

    // Roster chips: the lead marked, specialists plain.
    expect(canvas.getByText("Diego").closest("span")!.parentElement!.textContent).toContain("lead");
    expect(canvas.getByText("Lila").closest("span")!.parentElement!.textContent).toContain("existing");

    // The boundary is spelled out: what goes, what stays.
    expect(canvas.getByText("Goes to Diego")).toBeInTheDocument();
    expect(canvas.getByText("The 135M report and this question")).toBeInTheDocument();
    expect(canvas.getByText("Stays with me")).toBeInTheDocument();
    expect(canvas.getByText("Your chat history and my memory of you")).toBeInTheDocument();

    // Nothing starts until you say yes — the actions are live, never disabled.
    expect(canvas.getByRole("button", { name: "Hand off" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Not yet" })).toBeEnabled();
  },
};

// ---- findings (open + snoozed) ----

/** Finding: the source card, why it matters, and what assumption it challenges. */
export const FindingChallenges: Story = {
  name: "Finding · challenges an assumption",
  parameters: detailRoutes("paper-350m"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Small Models, Big Tables: Conditional Memory Below 1B")).toBeInTheDocument();
    // The venue and url share a line, so match the venue by prefix.
    expect(canvas.getByText(/arXiv preprint · Sep 30, 2026/)).toBeInTheDocument();
    expect(canvas.getByText("arxiv.org/abs/2609.18842")).toBeInTheDocument();
    expect(canvas.getByText(/Challenges Megan's memory:/)).toBeInTheDocument();
    expect(canvas.getByText(/Engram \(2025\) reports gains only above 1B params\./)).toBeInTheDocument();

    expect(canvas.getByRole("button", { name: "Send to Elliot" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  },
};

/** Snoozed finding: the detail resolves to its snoozed state; Unsnooze brings actions back. */
export const SnoozedFindingUnsnooze: Story = {
  name: "Snoozed finding · unsnooze",
  parameters: detailRoutes("nand-datasets"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Seeded as snoozed: no action buttons, just the bar with the until-label.
    expect(canvas.getByText("Snoozed · Until Monday 9:00 AM")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Attach to project" })).toBeNull();

    await user.click(canvas.getByRole("button", { name: "Unsnooze" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Attach to project" })).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: "Dismiss" })).toBeEnabled();
    expect(canvas.queryByText(/Snoozed ·/)).toBeNull();
  },
};

// ---- result ----

/** Result: the report loads from the mock API into a valid-rows-only table. */
export const ResultReportTable: Story = {
  name: "Result · report table",
  parameters: detailRoutes("report-135m"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Report rows arrive asynchronously from the (mock-only) API — never the network.
    await waitFor(() => expect(canvas.getByText("30.9")).toBeInTheDocument());
    expect(canvas.getByText("Baseline · 135M model")).toBeInTheDocument();
    expect(canvas.getByText("34.2")).toBeInTheDocument();
    expect(canvas.getByText("−9.6%")).toBeInTheDocument();

    // The primary action opens the report; the outline one views the loop.
    expect(canvas.getByRole("link", { name: "Open report" })).toHaveAttribute("href", "/reports/report-ngram-1");
    expect(canvas.getByRole("link", { name: "View loop" })).toHaveAttribute("href", "/work/ngram-135m");
  },
};

// ---- empty actions ----

const noActions: FindingItem = { ...inboxSeed.find((i): i is FindingItem => i.id === "paper-350m")!, id: "finding-no-actions", actions: [] };

/** An item with zero actions degrades to the snooze button alone — nothing disabled. */
export const EmptyActions: Story = {
  name: "Empty actions",
  parameters: detailRoutes("finding-no-actions", () => setWeaveSnapshot({
    items: [noActions],
    pulse: pulseSeed,
    presence: presenceSeed,
    calendar: calendarEvents,
  })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Why you're seeing this.")).toBeInTheDocument();

    // No resolve controls at all; the only affordance left is Snooze (the header's
    // run chip is a link, not an action).
    expect(canvas.getAllByRole("button")).toHaveLength(1);
    expect(canvas.getByRole("button", { name: "Snooze" })).toBeEnabled();
    expect(canvas.queryByRole("button", { name: "Send to Elliot" })).toBeNull();
    expect(canvas.queryByRole("button", { name: "Dismiss" })).toBeNull();

    // The item is still resolvable — through the keyboard 'e' path or snooze — so this
    // story asserts the read-only detail does not throw: the body renders normally.
    expect(canvas.getByText(/A new preprint reports Engram-style gains/)).toBeInTheDocument();
    expect(weave.resolve("finding-no-actions", "send")).toBeUndefined(); // unknown action is a no-op
  },
};
