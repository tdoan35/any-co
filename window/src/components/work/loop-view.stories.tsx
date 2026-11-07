// Task screen stories (ANY-20 M6): the real route — TaskPage + taskLoader on
// /work/:taskId — mounted in the harness memory router exactly as router.tsx
// declares it, plus a stub /reports/:reportId for the crossing link.
//
// State → story inventory (the loop screen's principal states):
//   proposed, no loop      → ProposedNoLoop (Dana's proposal card; nothing to play)
//   running, live at now   → RunningWaitingOnYou (play: lane row opens the Inspector,
//                             Brief closes it — the aside's open/closed pair)
//   paused / replay        → PausedOnVerdictReplay (play: marker scrub back into the
//                             recorded loop → fast-forward halts on the next verdict →
//                             play resumes to the end)
//   completed              → CompletedReportLink (results table; report link crosses pages)
//   blocked, budget spent  → BlockedBudgetSpent (play: the loop switcher walks ?loop=1,
//                             which is the stopped-by-you loop; URL is the contract)
//   live start (sim)       → LiveStartSimulated (play: pause the 1× start, scrub to a
//                             marker, clock frozen and URL untouched)
//   rework stages, inspector tabs, transport internals, lanes → the co-located
//   component files (Loop stepper / Inspector / Transport / Lanes / Brief panel)
//
// The loader runs against the mock API (no server; the harness guard would block one).
// Clocks never drift: every story pauses or parks the clock before asserting on it.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskPage, taskLoader } from "../../routes/task";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const VIEWPORTS = {
  wide: { name: "Wide · screen", styles: { width: "1600px", height: "1000px" } },
} as const;

const meta = {
  title: "Work/Task screen",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
    a11y: {
      // Scoped exception, token-level like every prior file: muted metas and warn
      // pills on translucent panels sit below the 4.5:1 bar — the same design tokens
      // the Weave/chat/studio/board cards scoped out. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const routes = [
  { path: "/work/:taskId", element: <TaskPage />, loader: taskLoader },
  { path: "/reports/:reportId", element: <p data-testid="report-probe">report</p> },
];
const taskScreen = (entry: string) => ({
  viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  router: { routes, initialEntries: [entry] },
});

// ---- proposed: a task with no loop yet ----

/** The proposal card is the whole page: no lanes, no transport, the decision lives in Weave. */
export const ProposedNoLoop: Story = {
  name: "Proposed · no loop, decide in Weave",
  parameters: taskScreen("/work/product-bet"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Can these results drive a real product?" })).toBeInTheDocument());
    expect(canvas.getByText("Diego frames the bet, Lila looks for demand, and Maya sketches a first experience.")).toBeInTheDocument();
    expect(canvas.getByText("Preview")).toBeInTheDocument();
    expect(canvas.getByRole("link", { name: /Decide in Weave/ })).toHaveAttribute("href", "/weave?item=handoff-product");
    // No loop to play: the transport is not mounted at all.
    expect(canvasElement.querySelector("input[aria-label='Scrub the loop']")).toBeNull();
  },
};

// ---- running: live at now, someone waiting on you ----

/** The running loop parks at now; a lane row opens the inspector, Brief returns the panel. */
export const RunningWaitingOnYou: Story = {
  name: "Running · live at now, inspector open and closed",
  parameters: taskScreen("/work/ngram-360m"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByRole("heading", { name: "Does the n-gram table still help one model size up, at 360M?" })).toBeInTheDocument());
    // Live at now, parked: the clock reads the loop's length on both ends and does not move.
    expect(canvas.getByText("2h 15m / 2h 15m")).toBeInTheDocument();
    expect(canvas.getByText("Live · now")).toBeInTheDocument();
    // Two open asks (the shard approval and Elliot's seed question) flag the loop.
    expect(canvas.getByText("Waiting on you · 2")).toBeInTheDocument();

    // Picking a lane member swaps the brief for their inspector.
    await user.click(canvas.getByRole("button", { name: /Jonah/ }));
    await waitFor(() => expect(canvas.getByText(/Context loaded/)).toBeInTheDocument());

    // …and Brief hands the aside back.
    await user.click(canvas.getByRole("button", { name: "Brief" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Brief" })).toBeInTheDocument());
    expect(canvas.queryByText(/Context loaded/)).toBeNull();

    // The screen state is URL-less: no param was touched by any of it.
    expect(storyRouter()!.state.location.search).toBe("");
  },
};

// ---- paused / replay: scrubbed into a recorded loop ----

/** Scrub back to the reviewer's verdict, fast-forward into the next halt, then play it home. */
export const PausedOnVerdictReplay: Story = {
  name: "Replay · verdict halt, fast-forward, resume",
  parameters: taskScreen("/work/ngram-135m"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByRole("heading", { name: "Does an n-gram lookup table improve a much smaller open model?" })).toBeInTheDocument());
    expect(canvas.getByText("Recorded loop")).toBeInTheDocument();
    expect(canvas.getByText("3h 12m / 3h 12m")).toBeInTheDocument();

    // The marker is the scrub: landing exactly on the bounce shows its verdict line.
    await user.click(canvas.getByRole("button", { name: "Changes requested at 2h 35m" }));
    await waitFor(() => expect(canvas.getByText("2h 35m / 3h 12m")).toBeInTheDocument());
    expect(canvas.getByText(/contaminated/)).toBeInTheDocument();

    // Fast-forward runs at 600× and halts on the next verdict (the accept, 35 loop-min later).
    await user.click(canvas.getByRole("button", { name: "Fast-forward" }));
    await waitFor(() => expect(canvas.getByText("3h 10m / 3h 12m")).toBeInTheDocument(), { timeout: 15_000 });
    expect(canvas.getByText(/Paused on the verdict/)).toBeInTheDocument();

    // Play resumes past the halt to the end of the loop.
    await user.click(canvas.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(canvas.getByText("3h 12m / 3h 12m")).toBeInTheDocument());
    expect(canvas.queryByText(/Paused on the verdict/)).toBeNull();
  },
};

// ---- completed: accepted, with its report ----

/** The accepted loop's callout carries the report's valid results and the crossing link. */
export const CompletedReportLink: Story = {
  name: "Completed · results, report link crosses pages",
  parameters: taskScreen("/work/ngram-135m"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByText(/Results are ready/)).toBeInTheDocument());
    // Only the valid rows make the callout; the contaminated first attempt does not.
    expect(canvas.getByText("Fused · attempt 2 (held-out split)")).toBeInTheDocument();
    expect(canvas.queryByText("Fused · attempt 1")).toBeNull();

    await user.click(canvas.getByRole("link", { name: /Open report/ }));
    await waitFor(() => expect(storyRouter()!.state.location.pathname).toBe("/reports/report-ngram-1"));
    expect(within(canvasElement).getByTestId("report-probe")).toBeInTheDocument();
  },
};

// ---- blocked: rework budget spent; loop 1 was stopped by you ----

/**
 * The blocked loop's callout, the spent-budget stepper line, and the segmented loop
 * switcher walking to loop 1 — the URL carries the loop, the screen follows.
 */
export const BlockedBudgetSpent: Story = {
  name: "Blocked · budget spent, loop switcher to stopped",
  parameters: taskScreen("/work/nand-probe?loop=2"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByRole("heading", { name: "Is NAND fast enough to serve n-gram table lookups?" })).toBeInTheDocument());
    expect(canvas.getByText(/Stopped on its budget\./)).toBeInTheDocument();
    expect(canvas.getByText("Rework budget spent · 2/2")).toBeInTheDocument();
    expect(canvas.getByText(/nothing else runs until you decide/)).toBeInTheDocument();
    expect(canvas.getByRole("tab", { name: "Loop 2" }).getAttribute("aria-selected")).toBe("true");

    // Loop 1 is the one you stopped; the URL is the whole contract.
    await user.click(canvas.getByRole("tab", { name: "Loop 1" }));
    await waitFor(() => expect(storyRouter()!.state.location.search).toBe("?loop=1"));
    await waitFor(() => expect(canvas.getByText(/You stopped it: the harness was timing the OS page cache/)).toBeInTheDocument());
    expect(canvas.getByRole("link", { name: "Go to the latest loop" })).toHaveAttribute("href", "/work/nand-probe");
  },
};

// ---- live start: a recorded loop played as if live ----

/** ?live=1 plays the recording from 0 at 1×; pause and a marker scrub pin the clock again. */
export const LiveStartSimulated: Story = {
  name: "Live start · simulated, pause and scrub pin it",
  parameters: taskScreen("/work/ngram-135m?live=1"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByText("Live start, simulated from the recorded loop")).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    // Pause the 1× march, then take the marker down into the first minute's artifact.
    await user.click(canvas.getByRole("button", { name: "Pause" }));
    await user.click(canvas.getByRole("button", { name: "plan.md at 12m 00s" }));
    await waitFor(() => expect(canvas.getByText("12m 00s / 3h 12m")).toBeInTheDocument());
    expect(canvas.getByText("Replay · 1×")).toBeInTheDocument();

    // Frozen: a beat later the clock reads exactly the same.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(canvas.getByText("12m 00s / 3h 12m")).toBeInTheDocument();

    // The live start lives in the URL and stays there.
    expect(storyRouter()!.state.location.search).toBe("?live=1");
  },
};
