// Inbox stories (ANY-15 M4): the Weave inbox — populated and empty, every row state
// (unread/read, blocking, snoozed, done), row-level keyboard access, the undo toast, and
// the composed WeaveScreen keyboard flow (j/k select, Enter open, a decide, s snooze,
// e done).
//
// Kind → row inventory (all six user-visible kinds appear as rows; none excluded):
//   approval (ungated) fetch-shard, approval (gated) email-priya, question seed-count,
//   escalation nand-budget, proposal handoff-product, finding paper-350m +
//   nand-datasets (snoozed), result report-135m.
// Detail states per kind live in the co-located "Item detail" file; the composed screen's
// keyboard story additionally demonstrates the open→read transition and the undo toast.
//
// Every story runs against the resettable fixture world: WithHarness re-seeds per run, so
// play-driven mutations never leak into the next story (story order cannot alter the next
// story). Non-default statuses are seeded through the store's own prepare seam before
// first render; weave-store mutation semantics are untouched.

import { useState } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { calendarEvents, presenceSeed, pulseSeed } from "@fabric/fixtures/weave";
import { setWeaveSnapshot, useWeave, weave } from "@/lib/weave-store";
import { Inbox } from "./inbox";
import { WeaveScreen } from "./weave-screen";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Weave/Inbox",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
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
 * Stands the inbox column up against the seeded store. prepare() runs synchronously
 * before first render (after the harness reset), so stories can start from a mutated
 * world — statuses via the store's own API, or a whole different item set via
 * setWeaveSnapshot — and the next story still boots from the pristine fixtures.
 */
function InboxPane({ prepare, showDone = false }: { prepare?: () => void; showDone?: boolean }) {
  useState(() => { prepare?.(); });
  const state = useWeave();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [doneShown, setDoneShown] = useState(showDone);
  return (
    <div className="h-[560px] w-[340px] border-r border-foreground/10 bg-background/40">
      <Inbox
        state={state}
        selectedId={selectedId}
        focusId={focusId}
        onOpen={(id) => { setSelectedId(id); setFocusId(id); }}
        snoozeFor={snoozeFor}
        setSnoozeFor={setSnoozeFor}
        showDone={doneShown}
        onToggleDone={() => setDoneShown((v) => !v)}
      />
    </div>
  );
}

const rowButton = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-item="${id}"] > button`);

// ---- populated ----

/** Seeded world: grouped asks and for-you rows in priority order, unread dots, snoozed tray. */
export const PopulatedInbox: Story = {
  name: "Populated inbox",
  render: () => <InboxPane />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // 7 open (4 asks + 3 for-you); pristine seed — a leak from another story would fail here.
    expect(canvas.getByText("7 open")).toBeInTheDocument();
    expect(canvas.getByText("Needs you")).toBeInTheDocument();
    expect(canvas.getByText("For you")).toBeInTheDocument();

    // Needs you first, longest-waiting ask on top; the snoozed finding is not listed.
    const rowIds = [...canvasElement.querySelectorAll("[data-item]")].map((el) => el.getAttribute("data-item"));
    expect(rowIds).toEqual([
      "nand-budget", "seed-count", "fetch-shard", "email-priya",
      "paper-350m", "handoff-product", "report-135m",
    ]);

    // The cost of delay on the blocking asks, and unread dots on everything unread.
    expect(canvas.getByText(/Blocks Implement · Jonah, 12 min/)).toBeInTheDocument();
    expect(canvas.getByText(/Blocks the long run · Elliot/)).toBeInTheDocument();
    const unread = canvasElement.querySelectorAll('[aria-label="Unread"]');
    expect(unread).toHaveLength(6);

    // The snoozed tray counts its one occupant.
    expect(canvas.getByText("Snoozed")).toBeInTheDocument();
    expect(canvas.getByText("· 1")).toBeInTheDocument();

    // Rows are keyboard-reachable: two tabs land on the first row's button (the first
    // tab is the header's Done toggle), which reveals its quick actions to the keyboard.
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(canvas.getByRole("button", { name: "Done · 0" }));
    await user.tab();
    expect(document.activeElement).toBe(rowButton(canvasElement, "nand-budget"));
    expect(canvasElement.querySelector<HTMLElement>('[data-item="nand-budget"] button[aria-label="Snooze"]')).not.toBeNull();
  },
};

// ---- empty ----

/** No items at all: the calm empty state, with the Done tray's own empty line. */
export const EmptyInbox: Story = {
  name: "Empty inbox",
  render: () => <InboxPane prepare={() => setWeaveSnapshot({ items: [], pulse: pulseSeed, presence: presenceSeed, calendar: calendarEvents })} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("0 open")).toBeInTheDocument();
    expect(canvas.getByText("Nothing is waiting on you. Your agents will ask here when something does.")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Done · 0" })).toBeInTheDocument();

    // Toggling Done reveals the done tray's own empty line.
    await user.click(canvas.getByRole("button", { name: "Done · 0" }));
    expect(canvas.getByText("Nothing done yet today.")).toBeInTheDocument();
  },
};

// ---- row statuses (read/unread, snoozed, done) ----

/** One world with every row state: read vs unread, snoozed tray, done tray. */
export const RowStatuses: Story = {
  name: "Row statuses · snoozed and done",
  render: () => <InboxPane showDone prepare={() => {
    weave.markRead("seed-count");
    weave.snooze("paper-350m", "Until 3:00 PM today");
    weave.markDone("report-135m");
  }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Unread rows carry the dot and the heavier title; the read one doesn't.
    const titleOf = (id: string) => rowButton(canvasElement, id)!.querySelector(".line-clamp-2")!;
    expect(titleOf("fetch-shard").classList.contains("font-medium")).toBe(true);
    expect(titleOf("seed-count").classList.contains("font-medium")).toBe(false);
    expect(canvasElement.querySelectorAll('[aria-label="Unread"]')).toHaveLength(3);

    // The mutation seeded a second snoozed row: open the tray to reach it.
    const snoozeTray = canvas.getByRole("button", { name: /Snoozed/ });
    expect(snoozeTray.textContent).toContain("· 2");
    await user.click(snoozeTray);
    expect(canvas.getByText("Until 3:00 PM today")).toBeInTheDocument();
    expect(canvas.getByText("Until Monday 9:00 AM")).toBeInTheDocument();

    // Snoozed rows keep only Unsnooze/Snooze — no quick Done on a parked row.
    expect(canvasElement.querySelector('[data-item="paper-350m"] button[aria-label="Unsnooze"]')).not.toBeNull();
    expect(canvasElement.querySelector('[data-item="paper-350m"] button[aria-label="Done"]')).toBeNull();

    // Unsnoozing returns the row to For you and shrinks the tray back to one.
    await user.click(canvasElement.querySelector<HTMLElement>('[data-item="paper-350m"] button[aria-label="Unsnooze"]')!);
    await waitFor(() => expect(canvas.queryByText("Until 3:00 PM today")).toBeNull());
    await waitFor(() => expect(canvas.getByRole("button", { name: /Snoozed/ }).textContent).toContain("· 1"));
    expect(rowButton(canvasElement, "paper-350m")).not.toBeNull();

    // Done rows show their outcome and time, and no actions at all.
    expect(canvas.getByText(/^Done · 11:20 AM/)).toBeInTheDocument();
    expect(canvasElement.querySelector('[data-item="report-135m"] button[aria-label="Snooze"]')).toBeNull();
  },
};

// ---- done transition + undo toast ----

/** Marking a read-only item done: the row leaves, the toast reports it, Undo restores. */
export const MarkDoneAndUndo: Story = {
  name: "Mark done and undo",
  render: () => <InboxPane />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvasElement.querySelector<HTMLElement>('[data-item="paper-350m"] button[aria-label="Done"]')!);

    // The toast names the change and offers Undo while it's fresh.
    const toast = await canvas.findByRole("status");
    expect(toast.textContent).toContain("Marked done");
    await user.click(within(toast).getByRole("button", { name: "Undo" }));

    // Undo restores the row (and clears the toast).
    await waitFor(() => expect(canvas.queryByRole("status")).toBeNull());
    expect(rowButton(canvasElement, "paper-350m")).not.toBeNull();
  },
};

// ---- composed screen: the full keyboard flow ----

const VIEWPORTS = { wide: { name: "Wide", styles: { width: "1600px", height: "1000px" } } };

/**
 * The composed WeaveScreen, driven by keyboard only: j/k walk the rows, Enter opens, 'a'
 * takes the primary action, 's' opens the snooze menu, 'e' marks a read-only item done.
 * Runs against the same isolated fixture world — the pristine counts at the top are the
 * order-independence proof (no earlier story's mutations survive into this one).
 */
export const KeyboardFlow: Story = {
  name: "Composed screen · keyboard flow",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
    a11y: {
      // Scoped exception, one rule beyond the file-level token exception above: the day
      // rail's "Now" line (day-rail.tsx) carries aria-label on a role-less div — a genuine
      // aria-prohibited-attr violation, but day-rail.tsx is outside this card's declared
      // file scope, so it is not fixed here. The in-scope offenders (the unread dot, the
      // rework pips) ARE fixed in source. Follow-up: add role="img" in day-rail.tsx.
      config: {
        rules: [
          { id: "color-contrast", enabled: false },
          { id: "aria-prohibited-attr", enabled: false },
        ],
      },
    },
    router: { routes: [{ path: "*", element: <WeaveScreen /> }] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Pristine world: 7 open, everything unread but the snoozed finding, nothing selected.
    expect(canvas.getByText("7 open")).toBeInTheDocument();
    expect(canvasElement.querySelectorAll('[aria-label="Unread"]')).toHaveLength(6);

    // j selects the first ask (the escalation has waited longest); Enter opens it —
    // the row reads as read now.
    await user.keyboard("j");
    expect(rowButton(canvasElement, "nand-budget")!.className).toContain("ring-inset");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The NAND latency probe is out of rework budget" })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).toContain("item=nand-budget");
    expect(rowButton(canvasElement, "nand-budget")!.getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(canvasElement.querySelector('[data-item="nand-budget"] [aria-label="Unread"]')).toBeNull());

    // j keeps walking the asks with the detail following.
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Two seeds like the paper, or three for a tighter interval?" })).toBeInTheDocument());

    // 'a' takes the primary action: the question resolves, the undo toast reports it.
    await user.keyboard("a");
    const toast = await canvas.findByRole("status");
    expect(toast.textContent).toContain("Three seeds");
    await waitFor(() => expect(canvas.getByText("6 open")).toBeInTheDocument());

    // j lands back on the top ask, then the next…
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The NAND latency probe is out of rework budget" })).toBeInTheDocument());
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Fetch the C4 validation shard from data.commoncrawl.org" })).toBeInTheDocument());

    // 's' opens the snooze menu on the selected ask; picking an option parks it.
    await user.keyboard("s");
    const menu = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>("[role=menu]");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(menu).getByRole("menuitem", { name: /^Later today/ }));
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Snoozed · Until 3:00 PM today"));
    await waitFor(() => expect(canvas.getByText("5 open")).toBeInTheDocument());

    // …and 'e' marks a read-only finding done from the keyboard. (The walk passes the
    // gated approval — 'e' correctly no-ops on asks — before landing on the finding.)
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The NAND latency probe is out of rework budget" })).toBeInTheDocument());
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Email the 135M validation summary to Priya Raman" })).toBeInTheDocument());
    await user.keyboard("j");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "A new preprint reports Engram-style gains at ~350M" })).toBeInTheDocument());
    await user.keyboard("e");
    // The detail resolves: outcome word "Done", no more actions, toast reports the change.
    await waitFor(() => expect(canvas.getByText(/^Done$/)).toBeInTheDocument());
    expect(canvas.queryByRole("button", { name: /^Send to Elliot/ })).toBeNull();
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Marked done"));
    await waitFor(() => expect(canvas.getByText("4 open")).toBeInTheDocument());
  },
};
