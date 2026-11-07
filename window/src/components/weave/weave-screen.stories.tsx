// Weave screen stories (ANY-16 M4): the composed screen — wide three-column vs narrow
// stacked composition, Pulse filter switching on the real segmented control, detail
// open/close through the URL, the narrow rail sheet, and direct-vs-repeated navigation
// landing on identical date and contents.
//
// State → story inventory (composition and navigation states; row-level and detail
// states live in the co-located Inbox / Item detail / Pulse / Day rail files):
//   wide three-column   → WideThreeColumn (play: filter switch, rail visible)
//   detail open/closed  → OpenDetailAndBack (play: row → URL param → detail → back →
//                         re-open; identical heading both times)
//   direct navigation   → DirectLoadDetail (play: ?item= lands on the same detail,
//                         same rail date, as repeated navigation)
//   narrow + sheet      → NarrowRailSheet (play: sheet open/close, pick inside the
//                         sheet, stacked detail open)
//   keyboard flow       → covered in Inbox · "Composed screen · keyboard flow" (ANY-15)
//
// Documented exclusions:
//   - The title-bar back/forward history walk is not asserted: the keyboard-flow story
//     in the Inbox file already pins the URL contract via the story router, and the
//     frameless title bar itself is a shell component outside this file's scope.
//   - No wall-clock dependence: the harness pins the mock clock to WEAVE_NOW
//     (2026-10-02 11:20 PT), so the greeting, rail date and detail ages are stable.
//   - The a11y exception below is token-level only (see the other Weave files); the
//     day-rail now-line violation ANY-15 scoped out is fixed in this card.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WeaveScreen } from "./weave-screen";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const VIEWPORTS = {
  wide: { name: "Wide · three column", styles: { width: "1600px", height: "1000px" } },
  narrow: { name: "Narrow · stacked", styles: { width: "900px", height: "1200px" } },
} as const;

const meta = {
  title: "Weave/Screen",
  decorators: [WithHarness, tooltipDecorator],
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

const wide = {
  viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  router: { routes: [{ path: "*", element: <WeaveScreen /> }] },
};

const rowButton = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-item="${id}"] > button`);

// ---- wide: three-column composition ----

/** 1600px: inbox, pulse and the day rail side by side; the filter switches live. */
export const WideThreeColumn: Story = {
  name: "Wide · three columns and filter switch",
  parameters: wide,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // All three regions render; the narrow-only affordances don't.
    expect(canvasElement.querySelector('section[aria-label="Inbox"]')).not.toBeNull();
    expect(canvasElement.querySelector('section[aria-label="Pulse"]')).not.toBeNull();
    expect(canvasElement.querySelector('aside[aria-label="Today"]')).not.toBeNull();
    expect(canvas.queryByRole("button", { name: "Your day" })).toBeNull();
    expect(canvas.getByText("Good morning, Ty")).toBeInTheDocument();

    // Pristine world on all three columns at once.
    expect(canvas.getByText("7 open")).toBeInTheDocument();
    expect(canvas.getByText("2 waiting on you · 1 blocked")).toBeInTheDocument();
    expect(canvas.getByText(/4 things need you:/)).toBeInTheDocument();

    // The segmented control drives the real filter state: everything reveals the
    // quiet event lines; highlights folds them back under the reveal affordance.
    await user.click(canvas.getByRole("tab", { name: "Everything" }));
    await waitFor(() => expect(canvas.getByText(/set up a pinned Python environment in the Sprite\./)).toBeInTheDocument());
    expect(canvas.queryByRole("button", { name: /quiet updates hidden/ })).toBeNull();
    await user.click(canvas.getByRole("tab", { name: "Highlights" }));
    await waitFor(() => expect(canvas.queryByText(/set up a pinned Python environment in the Sprite\./)).toBeNull());
    expect(canvas.getByRole("button", { name: "3 quiet updates hidden · Show" })).toBeInTheDocument();
  },
};

// ---- wide: detail open/close through the URL ----

/** Opening a row swaps the center column to the detail and back, via ?item=. */
export const OpenDetailAndBack: Story = {
  name: "Detail · open, close, re-open",
  parameters: wide,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(rowButton(canvasElement, "nand-budget")!);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The NAND latency probe is out of rework budget" })).toBeInTheDocument());
    expect(canvasElement.querySelector('section[aria-label="Pulse"]')).toBeNull();
    expect(canvasElement.querySelector('section[aria-label="The NAND latency probe is out of rework budget"]')).not.toBeNull();
    expect(storyRouter()!.state.location.search).toContain("item=nand-budget");
    expect(rowButton(canvasElement, "nand-budget")!.getAttribute("aria-current")).toBe("true");
    expect(canvas.getByText("2 / 2 spent")).toBeInTheDocument();

    // The header's back control returns to Pulse and clears the URL.
    await user.click(canvas.getByRole("button", { name: "Pulse esc" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Pulse" })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).not.toContain("item=");
    expect(rowButton(canvasElement, "nand-budget")!.getAttribute("aria-current")).toBeNull();

    // Repeated navigation lands on identical contents (pinned clock, same fixtures).
    await user.click(rowButton(canvasElement, "nand-budget")!);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The NAND latency probe is out of rework budget" })).toBeInTheDocument());
    expect(canvas.getByText("2 / 2 spent")).toBeInTheDocument();
    expect(canvas.getByText(/10:44 AM/)).toBeInTheDocument();
  },
};

/** Direct load: ?item= renders the detail with no clicks, identical to re-opening. */
export const DirectLoadDetail: Story = {
  name: "Detail · direct navigation is identical",
  parameters: { ...wide, router: { routes: [{ path: "*", element: <WeaveScreen /> }], initialEntries: ["/?item=seed-count"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The detail, the selection and the rail date — straight from the URL.
    expect(canvas.getByRole("heading", { name: "Two seeds like the paper, or three for a tighter interval?" })).toBeInTheDocument();
    expect(canvas.getByText(/24 min ago/)).toBeInTheDocument();
    expect(rowButton(canvasElement, "seed-count")!.getAttribute("aria-current")).toBe("true");
    expect(canvas.getByText("Fri, Oct 2")).toBeInTheDocument();

    // Close, then navigate again by row: same heading, same age, same date.
    await user.click(canvas.getByRole("button", { name: "Pulse esc" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Pulse" })).toBeInTheDocument());
    await user.click(rowButton(canvasElement, "seed-count")!);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Two seeds like the paper, or three for a tighter interval?" })).toBeInTheDocument());
    expect(canvas.getByText(/24 min ago/)).toBeInTheDocument();
    expect(canvas.getByText("Fri, Oct 2")).toBeInTheDocument();
  },
};

// ---- narrow: stacked layout and the rail sheet ----

/** Below the three-column breakpoints: the rail lives in a sheet, the detail stacks. */
export const NarrowRailSheet: Story = {
  name: "Narrow · rail sheet and stacked detail",
  parameters: {
    ...wide,
    viewport: { defaultViewport: "narrow", viewports: VIEWPORTS },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The rail column is hidden at this width; the header carries the open affordance.
    const aside = canvasElement.querySelector('aside[aria-label="Today"]')!;
    expect(getComputedStyle(aside).display).toBe("none");
    await user.click(canvas.getByRole("button", { name: "Your day" }));

    // The sheet (portaled to the body, so scope there) carries the same rail.
    const dialog = await within(document.body).findByRole("dialog");
    const sheet = within(dialog);
    expect(sheet.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(sheet.getByRole("button", { name: "Friday, October 2 · 360M run in progress" })).toBeInTheDocument();

    // Picking inside the sheet drives the shared rail state: an empty day appears.
    await user.click(sheet.getByRole("button", { name: "Tuesday, October 6" }));
    await waitFor(() => expect(sheet.getByText("Nothing on your calendar.")).toBeInTheDocument());

    // Close both ways — the sheet's own control, then Escape on a re-open.
    await user.click(sheet.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
    await user.click(canvas.getByRole("button", { name: "Your day" }));
    await waitFor(() => expect(within(document.body).getByRole("dialog")).toBeInTheDocument());
    // Radix closes on Escape from inside the sheet. On open it lands focus on the first
    // focusable — a presence face — whose tooltip owns the dismissable-layer stack and
    // swallows the first Escape (a real-user quirk of the strip, not the sheet). The
    // tooltip's open state lands a tick after the sheet's auto-focus, so wait for it to
    // mount before pressing Escape: pressing earlier races the mount and the tooltip can
    // open after the keypress. Press Escape twice: the first closes the tooltip, the
    // second the sheet — both orders converge on a closed sheet and no tooltip.
    await waitFor(
      () => expect(document.body.querySelectorAll("[role=tooltip]")).not.toHaveLength(0),
      { timeout: 3000 },
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.body.querySelectorAll("[role=tooltip]")).toHaveLength(0));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull(), { timeout: 3000 });

    // With no rail column, an opened item stacks below the inbox.
    await user.click(rowButton(canvasElement, "fetch-shard")!);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Fetch the C4 validation shard from data.commoncrawl.org" })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).toContain("item=fetch-shard");
  },
};
