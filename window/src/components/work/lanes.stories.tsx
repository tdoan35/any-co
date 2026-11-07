// Lanes stories (ANY-20 M6): who did what, per member row — states, the bounce arrow and
// the row selection that drives the inspector. The view comes from the production
// projection over the typed fixtures, exactly what LoopScreen passes.
//
// State → story inventory:
//   running, waits + blocked → LiveWaitingOnYou (wait/blocked labels, now-line, ETA)
//   bounce                   → BounceArrowDrawn (the SVG way-back appears after the gate)
//   replay, finished         → EveryRowDone (all five members done at the end)
//   selection                → RowSelectionToggles (play: click toggles aria-pressed,
//                               the same toggle LoopScreen wires to the inspector)
//   rework row               → covered by the pill in Work/Inspector (ReworkingAfterBounce);
//                              the lane itself renders the same segment dashed
//
// Assertions read row text and aria state; the geometry (left/width) is CSS, not asserted.

import { useMemo, useState } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runs as fixtures, runEventsById } from "@fabric/fixtures/work";
import type { Run, RunEvent } from "@fabric/contracts";
import { laneDomain, projectRun, teamOf } from "@/lib/run-state";
import { Lanes } from "./lanes";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Lanes",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: state words on soft
      // backgrounds sit below the 4.5:1 bar. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const m = (min: number) => min * 60;

/** Lanes with live selection, exactly as LoopScreen wires it (toggle on re-click). */
function LanesStage({ run, events, t }: { run: Run; events: RunEvent[]; t: number }) {
    const [selected, setSelected] = useState<string>();
    const view = useMemo(() => projectRun(run, events, t), [run, events, t]);
    return (
      <div className="rounded-xl border border-foreground/10 bg-background/70">
        <Lanes
          run={run}
          team={teamOf(run)}
          view={view}
          t={t}
          domain={laneDomain(run, t, false)}
          selected={selected}
          onSelect={(id) => setSelected((s) => (s === id ? undefined : id))}
        />
      </div>
    );
}

const lane = (run: Run, events: RunEvent[], t: number) => ({ render: () => <LanesStage run={run} events={events} t={t} /> });
const run360 = fixtures.find((r) => r.id === "run-ngram360-1")!;
const run135 = fixtures[0];
const events360 = runEventsById[run360.id];
const events135 = runEventsById[run135.id];

/** Live at now: waits and the blocked shard name themselves on the row. */
export const LiveWaitingOnYou: Story = {
  name: "Running · waits, blocked and the now line",
  ...lane(run360, events360, m(135)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The wait/blocked labels appear on the row and on the segment pill.
    expect(canvas.getAllByText("Needs you · seeds").length).toBeGreaterThan(0);
    expect(canvas.getAllByText("Needs you · fetch").length).toBeGreaterThan(0);
    expect(canvas.getAllByText("Blocked · C4 shard").length).toBeGreaterThan(0);
    // The running loop's now-line is drawn at the loop's length.
    expect(canvas.getByText("Now")).toBeInTheDocument();
  },
};

/** After the gate bounces, the arrow back to the lead's re-plan is drawn. */
export const BounceArrowDrawn: Story = {
  name: "Bounce · the way-back arrow renders",
  ...lane(run135, events135, m(160)),
  play: async ({ canvasElement }) => {
    // The overlay svg is aria-decorative; its existence past the bounce is the assertion.
    // It appears once the ResizeObserver reports a width, so poll briefly.
    const deadline = Date.now() + 2000;
    while (!canvasElement.querySelector("svg path[marker-end]")) {
      if (Date.now() > deadline) throw new Error("lanes play: no bounce arrow after the review gate");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  },
};

/** Replay at the end: every member's row reads done. */
export const EveryRowDone: Story = {
  name: "Replay · every row done at the end",
  ...lane(run135, events135, m(192)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // One done word per member row; nothing is idle or working at the end.
    const dones = canvas.getAllByText("Done");
    expect(dones.length).toBe(5);
    expect(canvas.queryByText("Working")).toBeNull();
  },
};

/** Clicking a row selects it for the inspector; clicking again clears it. */
export const RowSelectionToggles: Story = {
  name: "Selection · row click toggles the inspector target",
  ...lane(run135, events135, m(100)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    const row = canvas.getByRole("button", { name: /Jonah/ });
    expect(row.getAttribute("aria-pressed")).toBe("false");
    await user.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    await user.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("false");
  },
};
