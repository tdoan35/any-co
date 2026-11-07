// Pulse stories (ANY-16 M4): Dana's pulse feed — the highlights/everything filter, the
// Dana brief, every PulseEntry kind, and the empty feed.
//
// Kind → story inventory (all four user-visible entry kinds; none excluded):
//   update  u-360 (on_track) → UpdateAckAndReply (ack + reply, play)
//   update  u-nand (at_risk) → HighlightsFilter (row present, quiet hidden)
//   update  u-135 (done)     → EverythingFilter (yesterday section + diff asserted)
//   event   e-survey (artifact) · e-handoff · quiet q-cache/q-env/q-snap
//                            → HighlightsFilter hides quiet, EventLinesAndArtifacts
//   memory  m-ckpt           → MemoryDecideAndUndo (keep → undo, play)
//   policy  synthetic po-story → PolicyChange (no policy entry exists in the fixture
//                               seed — policy rows only appear after an in-story
//                               resolve — so one is seeded via setWeaveSnapshot)
//   empty   no entries at all → EmptyPulse (brief only, no day sections)
//
// Documented exclusions:
//   - Pulse's `scrollTo` contract (a day-rail pick scrolls a day section into view) is
//     not asserted: smooth-scroll position is a timing-dependent visual. The section
//     ids it targets (`pulse-day-*`) and the pick flow itself are covered in the Day
//     rail and Screen files.
//   - No wall-clock dependence: the harness pins the mock clock to WEAVE_NOW
//     (2026-10-02 11:20 PT), so brief/calendar/event times are identical every run.
//   - The composed screen's filter switching is asserted on WeaveScreen itself in the
//     Screen file; here the filter is driven through the same onFilter seam ("Show").

import { useState } from "react";
import type { RouteObject } from "react-router";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed, type PolicyEntry } from "@fabric/fixtures/weave";
import { setWeaveSnapshot, useWeave } from "@/lib/weave-store";
import { Pulse, type PulseFilter } from "./pulse";

const meta = {
  title: "Weave/Pulse",
  decorators: [WithHarness],
  parameters: {
    a11y: {
      // Scoped exception, token-level like the other Weave files: muted-foreground text
      // on translucent panels sits below the 4.5:1 bar — the same design tokens the
      // prior cards scoped out. Fixing means changing the design tokens, outside this
      // card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Stands the pulse column up against the seeded store. prepare() runs synchronously
 * before first render (after the harness reset), so a story can start from a mutated
 * world while the next still boots from the pristine fixtures. `picked` records
 * onSelectItem calls so brief/link navigation is assertable.
 */
function PulsePane({ initialFilter = "highlights", prepare }: { initialFilter?: PulseFilter; prepare?: () => void }) {
  useState(() => { prepare?.(); });
  const state = useWeave();
  const [filter, setFilter] = useState<PulseFilter>(initialFilter);
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="w-[720px] bg-background/20 py-4">
      <Pulse state={state} filter={filter} onFilter={setFilter} onSelectItem={(id) => setPicked((p) => [...p, id])} scrollTo={null} />
      <div data-testid="picked">{picked.join(" ")}</div>
    </div>
  );
}

// The brief's "Talk to Dana" is a react-router Link, so every story mounts the pane
// inside the harness's memory router.
const pulseRoutes = (prepare?: () => void, initialFilter?: PulseFilter): { router: { routes: RouteObject[] } } => ({
  router: { routes: [{ path: "*", element: <PulsePane prepare={prepare} initialFilter={initialFilter} /> }] },
});

const withPolicyEntry = () => setWeaveSnapshot({
  items: inboxSeed,
  pulse: [...pulseSeed, {
    id: "po-story", kind: "policy", agentId: "jonah", at: "2026-10-02T10:45:00-07:00",
    text: "Jonah can fetch from data.commoncrawl.org until the 360M run ends. His allowlist is unchanged after that.",
  } satisfies PolicyEntry],
  presence: presenceSeed,
  calendar: calendarEvents,
});

// ---- highlights vs everything ----

/** Highlights (default): quiet entries fold under a count; the brief names every need. */
export const HighlightsFilter: Story = {
  name: "Highlights filter · quiet hidden",
  parameters: pulseRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The Dana brief: the mock-mode live line, every open ask named by brief, the
    // first for-you read, and the next calendar stop after the pinned 11:20 AM clock.
    expect(canvas.getByText("The 360M run is in Implement, and the 135M results are written up.")).toBeInTheDocument();
    expect(canvas.getByText(/4 things need you:/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "the NAND probe's budget" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Elliot's seed question" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Jonah's data fetch" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Megan's paper" })).toBeInTheDocument();
    expect(canvas.getByText(/and 2 more to read/)).toBeInTheDocument();
    expect(canvas.getByText("Next on your calendar: Lunch at 12:00 PM."));

    // Day sections exist for both seeded days, newest first.
    expect(canvas.getByText("Today")).toBeInTheDocument();
    expect(canvas.getByText("Tuesday, Sep 29")).toBeInTheDocument();

    // Quiet events are folded under the reveal affordance, not shown.
    expect(canvas.queryByText(/cached the held-out split in her own sandbox\./)).toBeNull();
    const show = canvas.getByRole("button", { name: "3 quiet updates hidden · Show" });

    // Picking a brief calls onSelectItem with that item's id.
    await user.click(canvas.getByRole("button", { name: "Jonah's data fetch" }));
    expect(canvasElement.querySelector("[data-testid='picked']")!.textContent).toBe("fetch-shard");

    // Show is the filter seam: everything appears, the affordance disappears.
    await user.click(show);
    await waitFor(() => expect(canvas.getByText(/cached the held-out split in her own sandbox\./)).toBeInTheDocument());
    expect(canvas.queryByRole("button", { name: /quiet updates hidden/ })).toBeNull();
  },
};

/** Everything: quiet event lines render like the rest, with nothing folded away. */
export const EverythingFilter: Story = {
  name: "Everything filter · quiet shown",
  parameters: pulseRoutes(undefined, "everything"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // All three quiet event lines, verbatim.
    expect(canvas.getByText(/cached the held-out split in her own sandbox\./)).toBeInTheDocument();
    expect(canvas.getByText(/set up a pinned Python environment in the Sprite\./)).toBeInTheDocument();
    expect(canvas.getByText(/recorded a context snapshot for Setup \(6\.4k tokens\)\./)).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: /quiet updates hidden/ })).toBeNull();

    // The at-risk and done updates sit beside them, day-grouped.
    expect(canvas.getByText("NAND latency probe")).toBeInTheDocument();
    expect(canvas.getByText("At risk")).toBeInTheDocument();
    expect(canvas.getByText("n-gram fusion on a 135M model")).toBeInTheDocument();
    expect(canvas.getByText("Done")).toBeInTheDocument();
    expect(canvas.getByText("Perplexity")).toBeInTheDocument();
    expect(canvas.getByText("30.9")).toBeInTheDocument();
  },
};

// ---- update card interactions ----

/** Update card: health pill, before→after diff, artifact chips, ack and reply. */
export const UpdateAckAndReply: Story = {
  name: "Update · acknowledge and reply",
  parameters: pulseRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    // Scope to this update's card: the feed also shows the 135M update, which has
    // its own Acknowledge button.
    const card = canvas.getByText("n-gram fusion at 360M").closest("article")!;
    const scoped = within(card);

    expect(canvas.getByText("On track")).toBeInTheDocument();
    expect(canvas.getByText(/Megan's survey is in and the plan is set/)).toBeInTheDocument();
    expect(canvas.getByText("Stage")).toBeInTheDocument();
    expect(canvas.getByText("Prepare")).toBeInTheDocument();
    expect(canvas.getByText("Implement")).toBeInTheDocument();
    expect(canvas.getByText("~2:40 PM")).toBeInTheDocument();
    expect(scoped.getByRole("link", { name: "View loop" })).toHaveAttribute("href", "/work/ngram-360m");
    expect(canvas.getByText("plan.md")).toBeInTheDocument();

    // Acknowledge flips in place (aria-pressed), it does not remove the control.
    const ack = scoped.getByRole("button", { name: "Acknowledge" });
    await user.click(ack);
    await waitFor(() => expect(scoped.getByRole("button", { name: "Acknowledged" })).toHaveAttribute("aria-pressed", "true"));

    // Reply opens an inline input; Enter appends the reply to the card.
    await user.click(scoped.getByRole("button", { name: "Reply to Elliot" }));
    const input = canvas.getByPlaceholderText("Reply to Elliot…");
    await user.type(input, "Three seeds, please.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(canvas.getByText("Three seeds, please.")).toBeInTheDocument());
    expect(canvas.getByText(/sent to Elliot, who picks it up at the next step/)).toBeInTheDocument();
    expect(canvas.queryByPlaceholderText("Reply to Elliot…")).toBeNull();
  },
};

// ---- memory rows ----

/** Agent-memory row: Keep pins the lesson, Undo returns the undecided state. */
export const MemoryDecideAndUndo: Story = {
  name: "Memory · decide and undo",
  parameters: pulseRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("saved a lesson")).toBeInTheDocument();
    expect(canvas.getByText(/gradient checkpointing on a Sprite/)).toBeInTheDocument();
    expect(canvas.getByText("From Implement · 360M run. Only Jonah loads it; it never reaches Dana's memory.")).toBeInTheDocument();
    expect(canvas.getByText("agent memory")).toBeInTheDocument();

    await user.click(canvas.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(canvas.getByText("Kept")).toBeInTheDocument());
    await user.click(canvas.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(canvas.queryByText("Kept")).toBeNull());
    expect(canvas.getByRole("button", { name: "Forget" })).toBeInTheDocument();
  },
};

// ---- event and policy lines ----

/** Event lines: actor + deed in one line, artifacts as mono chips. */
export const EventLinesAndArtifacts: Story = {
  name: "Event lines · artifacts",
  parameters: pulseRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText(/handed Implement to Jonah\./)).toBeInTheDocument();
    expect(canvas.getByText(/finished the survey: 9 papers read, 3 cited\./)).toBeInTheDocument();
    // The artifact chip appears twice: on Megan's event line and on the 360M update card.
    expect(canvas.getAllByText("survey.md")).toHaveLength(2);
  },
};

/** Policy change line: the audit-trail card for autonomy you granted. */
export const PolicyChange: Story = {
  name: "Policy change line",
  parameters: pulseRoutes(withPolicyEntry),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Policy changed.")).toBeInTheDocument();
    expect(canvas.getByText("Jonah can fetch from data.commoncrawl.org until the 360M run ends. His allowlist is unchanged after that.")).toBeInTheDocument();
  },
};

// ---- empty ----

/** No entries at all: the brief alone, no day sections, no reveal affordance. */
export const EmptyPulse: Story = {
  name: "Empty pulse",
  parameters: pulseRoutes(() => setWeaveSnapshot({ items: [], pulse: [], presence: presenceSeed, calendar: calendarEvents })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Nothing is waiting on you right now. I'll ask here when that changes.")).toBeInTheDocument();
    expect(canvas.queryByText("Today")).toBeNull();
    expect(canvas.queryByRole("button", { name: /quiet updates hidden/ })).toBeNull();
    expect(canvas.queryByText("Policy changed.")).toBeNull();
  },
};
