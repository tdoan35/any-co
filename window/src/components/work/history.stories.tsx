// History ledger stories (ANY-19 M6): finished loops as PreviousLoops renders them —
// the populated ledger with both outcome shapes and both lenses, and the empty state.
//
// State → story inventory:
//   populated, project lens → LedgerRows (stopped loop 1 + the accepted recorded loop;
//                             play: the earlier loop deep-links ?loop=1, the latest plain)
//   populated, team lens    → same rows name the team either way here; the lens switch is
//                             covered on the board file (the corner swaps team/project) —
//                             the ledger's lens only changes that subtitle
//   empty                   → EmptyLedger
//   Caveat / stopped-accepted
//   mixes                   → the pills themselves are Work/Parts; outcomes here are the
//                             seeded loops' real ones
//
// Loops come from the production `previousLoops` over `summarize` — the exact call the
// board's History tab makes.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runs as fixtureRuns, tasks as fixtureTasks } from "@fabric/fixtures/work";
import { projects } from "@fabric/fixtures/sessions";
import { useWeave } from "@/lib/weave-store";
import { previousLoops, summarize } from "@/lib/work";
import { PreviousLoops } from "./history";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/History",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: muted meta text on the
      // translucent ledger rows sits below the 4.5:1 bar — the same design tokens the
      // Weave/chat/studio cards scoped out. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="ledger-location">{`Location: ${pathname}${search}`}</p>;
}

/** The ledger exactly as the Engram board's History tab builds it: every finished loop, newest first. */
function LedgerOf({ lens }: { lens: "project" | "team" }) {
  const weave = useWeave();
  const summaries = fixtureTasks.map((t) => summarize(t, fixtureRuns, weave));
  const loops = previousLoops(summaries.filter((s) => s.task.projectId === "engram"));
  return (
    <div className="w-[46rem]">
      <PreviousLoops loops={loops} projects={projects} lens={lens} />
      <LocationProbe />
    </div>
  );
}

const ledgerRoutes = (lens: "project" | "team") => ({
  routes: [{ path: "*", element: <LedgerOf lens={lens} /> }],
});

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLAnchorElement>("li > a")];
const probe = (root: HTMLElement) => root.querySelector("[data-testid=ledger-location]")?.textContent;

/** Two finished loops: the stopped NAND retry and the accepted, recorded 135M run — replay affordances on both. */
export const LedgerRows: Story = {
  name: "Ledger · stopped and accepted loops",
  parameters: { router: ledgerRoutes("project") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("Previous loops")).toBeInTheDocument();
    expect(rows(canvasElement)).toHaveLength(2);

    const nandRow = rows(canvasElement).find((a) => a.textContent!.includes("NAND latency probe"))!;
    expect(nandRow.textContent).toContain("Loop 1 · Research Team");
    expect(nandRow.textContent).toContain("Stopped");
    expect(nandRow.textContent).toContain("rework 0/2");
    expect(within(nandRow).getByText(/Replay/)).toBeInTheDocument();

    const acceptedRow = rows(canvasElement).find((a) => a.textContent!.includes("n-gram fusion on a 135M model"))!;
    expect(acceptedRow.textContent).toContain("Loop 1 · recorded");
    expect(acceptedRow.textContent).toContain("Accepted");

    // The earlier loop deep-links with its number; the latest loop links plain.
    await user.click(nandRow);
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /work/nand-probe?loop=1"));
    await user.click(acceptedRow);
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /work/ngram-135m"));
  },
};

/** Nothing has finished: the dashed empty state, ready for the first loop. */
export const EmptyLedger: Story = {
  name: "Ledger · empty",
  parameters: {
    router: {
      routes: [
        {
          path: "*",
          element: (
            <div className="w-[46rem]">
              <PreviousLoops loops={[]} projects={projects} lens="project" />
            </div>
          ),
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Previous loops")).toBeInTheDocument();
    expect(canvas.getByText(/Nothing has finished yet\. Finished loops land here, ready to replay\./)).toBeInTheDocument();
  },
};
