// Team loops stories (ANY-19 M6): TeamLoops as Studio's team card and the chat's team
// panel embed it — the populated list over the store's tasks, and the empty invitation.
//
// State → story inventory:
//   populated  → TeamLoopsRows (play: the footer link lands on the team lens in Work)
//   empty      → TeamLoopsEmpty (store emptied; the ask-Dana line names the team)
//   the row link target (/work/:id) is the task screen, covered by the board files
//
// Unlike the board, TeamLoops reads the registry module's task store — the same one the
// route loader fills — so each story seeds it explicitly, the way the harness seeds the rest.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runs as fixtureRuns, tasks as fixtureTasks } from "@fabric/fixtures/work";
import { studioTeams } from "@fabric/fixtures/teams";
import { setWorkData, workTasks } from "@/lib/registry";
import { TeamLoops } from "./team-loops";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Team loops",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: muted meta lines on the
      // translucent rows sit below the 4.5:1 bar — the same design tokens the
      // Weave/chat/studio cards scoped out. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="loops-location">{`Location: ${pathname}${search}`}</p>;
}

/** Points the registry's task store at the fixture world (as the route loader would), then renders.
 *  The length check keeps the render-time seed from notifying on every pass (no render loop). */
function RowsOf({ empty }: { empty?: boolean }) {
  const wantTasks = empty ? [] : fixtureTasks;
  const wantRuns = empty ? [] : fixtureRuns;
  if (workTasks().length !== wantTasks.length) setWorkData(wantTasks, wantRuns);
  return (
    <div className="w-96">
      <TeamLoops team={studioTeams[0]} />
      <LocationProbe />
    </div>
  );
}

const rowsRoutes = { routes: [{ path: "*", element: <RowsOf /> }] };
const emptyRoutes = { routes: [{ path: "*", element: <RowsOf empty /> }] };

const rows = (root: HTMLElement) => [...root.querySelectorAll("li > a")];
const probe = (root: HTMLElement) => root.querySelector("[data-testid=loops-location]")?.textContent;

/** Every Research Team task, ugliest-first, with loop and rework metas — and the jump to the team's board. */
export const TeamLoopsRows: Story = {
  name: "Rows · the team's loops, jump to Work",
  parameters: { router: rowsRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(rows(canvasElement)).toHaveLength(3);
    const nand = rows(canvasElement).find((a) => a.textContent!.includes("NAND latency probe"))!;
    expect(nand.textContent).toContain("Loop 2 · Review");
    expect(nand.textContent).toContain("rework 2/2");
    const proposed = rows(canvasElement).find((a) => a.textContent!.includes("Can these results drive a real product?"));
    expect(proposed).toBeUndefined(); // the Product Team's proposal is not the Research Team's loop

    // The footer hands off to the team lens, with the team preselected in the URL.
    await user.click(canvas.getByRole("link", { name: /Open Research Team's board in Work/ }));
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /work?view=teams&team=research"));
  },
};

/** A team with nothing in flight: the empty state asks Dana for the first task, by name. */
export const TeamLoopsEmpty: Story = {
  name: "Empty · no loops yet",
  parameters: { router: emptyRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/No loops yet\. Ask Dana to hand Research Team a task\./)).toBeInTheDocument();
    expect(rows(canvasElement)).toHaveLength(0);
  },
};
