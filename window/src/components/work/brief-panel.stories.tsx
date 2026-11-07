// Brief panel stories (ANY-20 M6): the delegation boundary and the done-when criteria as
// evidence lands. The criteria view is the production projection over the 135M fixtures —
// the same object the screen's aside shows while no member is selected.
//
// State → story inventory:
//   mid-loop, mixed checks → MixedChecksMidLoop (1 of 4 met, the failing check's note)
//   end, all met           → AllMetAtEnd (4 of 4, the reviewer's last check visible)
//   the static sections    → asserted inside both (constraints, budget, preferences, stayed)
//
// The rework path of the criteria (fail → pass on the second pass) is the same component
// state at a later t — covered by AllMetAtEnd, which follows the bounce.

import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { runEventsById, runs as fixtures } from "@fabric/fixtures/work";
import type { Run, RunEvent } from "@fabric/contracts";
import { projectRun } from "@/lib/run-state";
import { BriefPanel } from "./brief-panel";

const meta = {
  title: "Work/Brief panel",
  decorators: [WithHarness],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: pending criteria and muted
      // notes sit below the 4.5:1 bar on the translucent panel. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const m = (min: number) => min * 60;

function BriefStage({ run, events, t }: { run: Run; events: RunEvent[]; t: number }) {
  const view = useMemo(() => projectRun(run, events, t), [run, events, t]);
  return (
    <div className="w-[340px] rounded-xl border border-foreground/10 bg-background/70">
      <BriefPanel run={run} criteria={view.criteria} teamName="Research Team" />
    </div>
  );
}

const brief = (t: number) => {
  const run = fixtures[0];
  const events = runEventsById[run.id];
  return { render: () => <BriefStage key={t} run={run} events={events} t={t} /> };
};

/** Mid-first-pass: one check green, one red with its note, two not checked yet. */
export const MixedChecksMidLoop: Story = {
  name: "Mid-loop · 1 of 4 met, failing check annotated",
  ...brief(m(146)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("1 of 4 met")).toBeInTheDocument();
    expect(canvas.getByText(/41% of eval n-grams appear in the table's corpus/)).toBeInTheDocument();
    expect(canvas.getByText(/Both models scored on heldout-v1/)).toBeInTheDocument();
    // The boundary sections are always on the panel.
    expect(canvas.getByText("Cached corpus only; no new downloads")).toBeInTheDocument();
    expect(canvas.getByText(/Rework 2 · 4h/)).toBeInTheDocument();
    expect(canvas.getByText("Short status updates")).toBeInTheDocument();
    expect(canvas.getByText("Stayed with Dana")).toBeInTheDocument();
  },
};

/** After the rework: every criterion has evidence, the reviewer's check included. */
export const AllMetAtEnd: Story = {
  name: "End · 4 of 4 met after the rework",
  ...brief(m(192)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("4 of 4 met")).toBeInTheDocument();
    expect(canvas.getByText(/Reproduced 30\.9 ± 0\.2 independently/)).toBeInTheDocument();
    expect(canvas.getByText(/Caveats and the proxy's limits are stated/)).toBeInTheDocument();
    expect(canvas.queryByText("Not checked yet")).toBeNull();
  },
};
