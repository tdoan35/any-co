// Loop stepper stories (ANY-20 M6): one story per state the stepper can draw, computed
// through the production projection (projectRun → stages/rework) over the typed fixtures —
// the same view objects the task screen would hand it.
//
// State → story inventory:
//   first pass, mid-flight   → MidFirstPass (Implement active, Review not started)
//   bounced at the gate      → SentBackToOnePassDone (Review sent back, earlier pass done,
//                               the way-back names the rework spend)
//   waiting, budget spent    → WaitingBudgetSpent (the nand loop 2 end state)
//   accepted, every stage    → AcceptedAllDone (the 135M loop's final board)
//   skipped                  → unreachable with these fixtures: every loop that passes a
//                              stage visits each one before it (no stage is jumped);
//                              noted here rather than forced
//
// Every assertion reads the accessible node (`role=listitem` aria-label), so a state
// regression or a lost word fails the story.

import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { runs as fixtures, runEventsById } from "@fabric/fixtures/work";
import type { Run, RunEvent } from "@fabric/contracts";
import { agentOf } from "@/components/weave/parts";
import { projectRun, teamOf } from "@/lib/run-state";
import { leadOf } from "@/lib/work";
import { LoopStepper } from "./loop-stepper";

const meta = {
  title: "Work/Loop stepper",
  decorators: [WithHarness],
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

/** Renders the stepper exactly as LoopScreen does: projection at t, rework from the log. */
function StepperStage({ run, events, t }: { run: Run; events: RunEvent[]; t: number }) {
  const view = useMemo(() => projectRun(run, events, t), [run, events, t]);
  const lead = leadOf(teamOf(run));
  return (
    <div className="rounded-xl border border-foreground/10 bg-background/70 p-4">
      <LoopStepper stages={view.stages} reworkUsed={view.reworkUsed} reworkBudget={run.reworkBudget} leadName={agentOf(lead).name} />
    </div>
  );
}

const stage = (run: Run, events: RunEvent[], t: number) => ({ render: () => <StepperStage run={run} events={events} t={t} /> });
const nand2 = fixtures.find((r) => r.id === "run-nand-2")!;
const run135 = fixtures[0];
const events135 = runEventsById[run135.id];
const eventsN2 = runEventsById[nand2.id];

/** Mid-first-pass: implementation running, review untouched, budget line is the default promise. */
export const MidFirstPass: Story = {
  name: "First pass · Implement running, Review pending",
  ...stage(run135, events135, m(100)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("listitem", { name: "Implement: In progress" })).toBeInTheDocument();
    expect(canvas.getByRole("listitem", { name: "Prepare: Done" })).toBeInTheDocument();
    expect(canvas.getByRole("listitem", { name: "Review: Not started" })).toBeInTheDocument();
    expect(canvas.getByText("Review can send it back to Elliot · rework budget 2")).toBeInTheDocument();
  },
};

/** Just after the bounce: the gate reads sent-back, the first pass reads done-earlier. */
export const SentBackOnePassDone: Story = {
  name: "Sent back · review bounced, earlier pass done",
  ...stage(run135, events135, m(160)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("listitem", { name: "Review: Sent back" })).toBeInTheDocument();
    expect(canvas.getByRole("listitem", { name: "Implement: Done, earlier pass" })).toBeInTheDocument();
    expect(canvas.getByRole("listitem", { name: "Plan: In progress" })).toBeInTheDocument();
    expect(canvas.getByText("Sent back to Elliot · rework 1/2")).toBeInTheDocument();
  },
};

/** The blocked NAND loop's end: review waiting on you with both reworks spent. */
export const WaitingBudgetSpent: Story = {
  name: "Blocked · waiting on you, rework budget spent",
  ...stage(nand2, eventsN2, nand2.durationS),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("listitem", { name: "Review: Waiting on you" })).toBeInTheDocument();
    expect(canvas.getByRole("listitem", { name: "Implement: Done, earlier pass" })).toBeInTheDocument();
    expect(canvas.getByText("Rework budget spent · 2/2")).toBeInTheDocument();
  },
};

/** The accepted loop's final board: every stage done, the one rework still remembered. */
export const AcceptedAllDone: Story = {
  name: "Accepted · every stage done",
  ...stage(run135, events135, m(192)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const label of ["Plan", "Prepare", "Synthesize", "Implement", "Validate", "Review"]) {
      expect(canvas.getByRole("listitem", { name: `${label}: Done` })).toBeInTheDocument();
    }
    expect(canvas.getByText("Sent back to Elliot · rework 1/2")).toBeInTheDocument();
  },
};
