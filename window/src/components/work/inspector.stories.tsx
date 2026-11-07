// Inspector stories (ANY-20 M6): one member's panel — activity stream, context snapshot,
// tool policy — at points of the recorded 135M loop. The member/view come from the
// production projection; snapshots are the fixture's, filtered to this run as the screen does.
//
// State → story inventory:
//   working, streaming   → WorkingStreamsTerminal (term lines, the context-loaded receipt)
//   context tab          → ContextExpandsToSources (sections, per-source tokens, the collapse)
//   tools tab, denied    → ToolsPolicyAndDenied (allowed/blocked pills, the denied call)
//   idle before starting → NotStartedYet (empty activity, no snapshot yet)
//   rework               → ReworkingAfterBounce (the rework pill mid-second-pass)
//   waiting / blocked pills, Dana's-context footer → visible on the screen stories'
//   waiting rows; the dedicated states live in the lanes and screen files
//
// The panel is mounted at the sidebar's real width so the layout is the production one.

import { useMemo, useState } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { allSnapshots, runEventsById, runs as fixtures } from "@fabric/fixtures/work";
import type { Run, RunEvent } from "@fabric/contracts";
import { projectRun } from "@/lib/run-state";
import { Inspector } from "./inspector";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Inspector",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: the terminal's fixed palette
      // and muted metas sit below the 4.5:1 bar on this dark panel. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const m = (min: number) => min * 60;

/** The inspector as the aside mounts it, with the screen's toggle → here a no-op close. */
function InspectorStage({ run, events, t, agentId }: { run: Run; events: RunEvent[]; t: number; agentId: string }) {
  const [, setOpen] = useState<string>();
  const view = useMemo(() => projectRun(run, events, t), [run, events, t]);
  const member = view.members.find((mem) => mem.agentId === agentId);
  if (!member) throw new Error(`inspector story: ${agentId} has no member view at t=${t}`);
  const snapshots = allSnapshots.filter((s) => s.runId === run.id);
  return (
    <div className="h-[560px] w-[340px] overflow-hidden rounded-xl border border-foreground/10 bg-background/70">
      <Inspector member={member} run={run} view={view} t={t} snapshots={snapshots} onClose={() => setOpen(undefined)} />
    </div>
  );
}

const inspector = (agentId: string, t: number) => {
  const run = fixtures[0];
  const events = runEventsById[run.id];
  return { render: () => <InspectorStage key={`${agentId}-${t}`} run={run} events={events} t={t} agentId={agentId} /> };
};

/** Mid-implement: the terminal streams, the context receipt names the step's load. */
export const WorkingStreamsTerminal: Story = {
  name: "Working · terminal streams, context loaded",
  ...inspector("jonah", m(100)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("$ python build_ngram.py --n 4 --corpus data/")).toBeInTheDocument();
    expect(canvas.getByText(/Context loaded/)).toBeInTheDocument();
    expect(canvas.getByText("Soul, task brief, tool policy, 2 artifact refs. No chat transcript, no personal memory.")).toBeInTheDocument();
  },
};

/** The context tab: per-source tokens; a section expands to the text it was built from. */
export const ContextExpandsToSources: Story = {
  name: "Context · sections expand to their sources",
  ...inspector("jonah", m(100)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("tab", { name: "Context" }));
    expect(canvas.getByText("What Jonah loaded")).toBeInTheDocument();
    expect(canvas.getByText("Task brief").closest("li")).toBeInTheDocument();

    // The collapsed section opens to the compiled brief, exactly the text the run used.
    await user.click(canvas.getByRole("button", { name: /Task brief/ }));
    await waitFor(() => expect(canvas.getByText(/Objective: Test whether fusing an n-gram lookup table/)).toBeInTheDocument());
    expect(canvas.getByText(/Not loaded:/)).toBeInTheDocument();
  },
};

/** The tools tab: policy pills plus the run's denied calls with their reasons. */
export const ToolsPolicyAndDenied: Story = {
  name: "Tools · policy pills and the denied fetch",
  ...inspector("jonah", m(130)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("tab", { name: "Tools" }));
    expect(canvas.getByText("sprite.exec")).toBeInTheDocument();
    // Three allowed policies (exec, workspace write, artifacts) and one blocked fetch.
    expect(canvas.getAllByText("allowed").length).toBe(3);
    expect(canvas.getByText("blocked")).toBeInTheDocument();
    expect(canvas.getByText(/Blocked at 2h 01m:/)).toBeInTheDocument();
    // The fetch appears twice: once as policy, once in the denied log.
    expect(canvas.getAllByText("network.fetch").length).toBe(2);
    expect(canvas.getByText(/files\.example\.org/)).toBeInTheDocument();
  },
};

/** Before their first step: the empty states, verbatim. */
export const NotStartedYet: Story = {
  name: "Idle · nothing yet, no context loaded",
  ...inspector("carlos", m(100)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/Nothing yet\. Carlos hasn't started a step in this loop\./)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(canvas.getByRole("tab", { name: "Context" }));
    expect(canvas.getByText(/No context loaded yet\. Carlos assembles it when their first step starts\./)).toBeInTheDocument();
  },
};

/** During the rework pass the pill names the rework, not just the stage. */
export const ReworkingAfterBounce: Story = {
  name: "Rework · the pill reads the rework pass",
  ...inspector("jonah", m(180)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Rework")).toBeInTheDocument();
    expect(canvas.getByText("$ python build_ngram.py --n 4 --corpus data/train_only/")).toBeInTheDocument();
  },
};
