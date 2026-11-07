// Teams & Organizations stories (ANY-18 M5): the TeamsStudio pane body — your teams and
// community teams with expansion, both add paths, the community-exhausted state, and the
// organization folder with its editing flow. The composed page (header, ?view wiring) and
// the org→team cross-view jump live in studio-screen.stories.tsx; primitives in studio-ui.
//
// State → story inventory:
//   catalog: your 2 + community 3, status pills, install formatting, card meta → TeamCatalog
//   expanded owned team, Members/Workflow/Loops tabs, Escape close → OwnedTeamTabs
//   expanded community team, add-from-expanded lands in Your teams → CommunityTeamAdd
//   community add from the card's plus (no expansion) → AddCommunityFromCard
//   community exhausted ("added every community team", seeded empty) → CommunityExhausted
//   organization chart: folder tab, head, leads, shared badge, counts → OrgChart
//   org editing: remove slot, add copy, add community team (joins yours), Escape → OrgEditing
//   org team box jumps to the expanded team in the teams view → OrgTeamJumpsToTeams
//
// Recorded exclusions:
//   - Org handoff preview cards render only when VITE_API_MODE=http (httpMode gate); the
//     story build has no env file, so the block is absent here — asserted nowhere.
//   - Loops tab: the harness seeds registry + weave but no work tasks, so every team shows
//     the "No loops yet" empty state; task-backed rows belong to the Work surfaces.
//   - localAdds/slotEdits are component state and the harness reseeds per mount, so adds
//     cannot leak between stories; asserted anyway via post-action counts.
//   - Create team / Create organization header buttons: page chrome, covered in
//     studio-screen.stories.tsx.

import { useState, type ReactElement } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setRegistry } from "@/lib/registry";
import { storyRegistry } from "@/testing/seed";
import { TeamsStudio, type TeamsView } from "./teams-view";

const TooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Studio/Teams view",
  component: TeamsStudio,
  // Required-props placeholder: the mounted UI comes from each story's router harness
  // route element (a stage with the real view state), never from these args.
  args: { view: "teams", onViewChange: () => {} },
  decorators: [WithHarness, TooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like the other Studio/chat files: muted-foreground
      // text on translucent panels sits below the 4.5:1 bar — the same design tokens the
      // prior cards scoped out. Fixing means changing the design tokens, outside this
      // card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The SectionHead count chip — the section's live record count. */
const countChip = (root: HTMLElement, heading: RegExp) =>
  within(root).getByRole("heading", { name: heading }).querySelector("span")!.textContent;

/** The community grid's per-card add button (absent-safe). */
const addButtons = (root: HTMLElement) =>
  within(root).queryAllByRole("button", { name: / to your teams$/ });

const routesFor = (element: ReactElement) => ({
  routes: [{ path: "/agents", element }],
  initialEntries: ["/agents"],
});
const staticView = (view: TeamsView) => {
  const noop = () => {};
  return routesFor(<TeamsStudio view={view} onViewChange={noop} />);
};

/** Orgs pane with a live view state, so the org→teams handoff runs the real contract. */
function CrossingStage() {
  const [view, setView] = useState<TeamsView>("orgs");
  return <TeamsStudio view={view} onViewChange={setView} />;
}

/** The catalog with community teams emptied — the "added every team" state. */
function ExhaustedStage() {
  useState(() => setRegistry({ ...storyRegistry(), communityTeams: [] }));
  return <TeamsStudio view="teams" onViewChange={() => {}} />;
}

const exhaustedRoutes = routesFor(<ExhaustedStage />);
const crossingRoutes = routesFor(<CrossingStage />);

// -- teams catalog -----------------------------------------------------------

/** Both sections: two of yours (active + idle), three community cards, live counts. */
export const TeamCatalog: Story = {
  name: "Team catalog",
  parameters: { router: staticView("teams") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Section heads carry the live counts and the standing hints.
    expect(countChip(canvasElement, /Your teams/)).toBe("2");
    expect(countChip(canvasElement, /Community teams/)).toBe("3");
    expect(canvas.getByText("Dana proposes teams in chat; you approve them. Agents are reused across teams, never copied.")).toBeInTheDocument();
    expect(canvas.getByText("Teams shared by others. Adding one brings its members along, with empty memories.")).toBeInTheDocument();

    // Your section: one card per team with its status and origin.
    expect(canvas.getByText("Active")).toBeInTheDocument(); // Research Team
    expect(canvas.getByText("Idle")).toBeInTheDocument(); // Product Team; community cards show no status pill
    expect(canvas.getByText("Created in chat · today")).toBeInTheDocument();
    expect(canvas.getByText("Seeded")).toBeInTheDocument();
    expect(canvas.getByText("Led by Elliot · 5 members · no loops yet")).toBeInTheDocument();
    expect(canvas.getByText("Led by Diego · 4 members · no loops yet")).toBeInTheDocument();

    // Community section: author, install-count formatting, one add button per card.
    expect(canvas.getByText(/@wanderlist · 820 added/)).toBeInTheDocument();
    expect(canvas.getByText(/@shipnotes · 1.5k added/)).toBeInTheDocument();
    expect(canvas.getByText(/@ledgerly · 2.2k added/)).toBeInTheDocument();
    expect(addButtons(canvasElement).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add Trip Crew to your teams",
      "Add Launch Squad to your teams",
      "Add Money Desk to your teams",
    ]);
  },
};

// -- expanded owned team -----------------------------------------------------

/** Opening a yours-card expands it in place; the community shelf fades; tabs and Escape. */
export const OwnedTeamTabs: Story = {
  name: "Owned team · members, workflow, loops; Escape closes",
  parameters: { router: staticView("teams") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByText("Tests your research ideas end to end").closest("button") as HTMLElement);

    // Expanded in place; the community shelf is gone while a yours-team is open.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Research Team" })).toBeInTheDocument());
    await waitFor(() => expect(canvas.queryByText(/Community teams/)).toBeNull());

    // Members tab (default): five rows, the lead flagged, cross-team membership tagged,
    // each row linking into the agent profile.
    expect(canvas.getAllByRole("link")).toHaveLength(5);
    expect(canvas.getByText("Also on Product Team")).toBeInTheDocument(); // Jonah is on both
    expect(canvas.getByRole("link", { name: /Elliot/ })).toHaveAttribute("href", "/agents?agent=elliot");
    expect(canvas.getByRole("link", { name: /Carlos/ })).toHaveAttribute("href", "/agents?agent=carlos");

    // Workflow tab: staged pipeline, the parallel stage flagged, the review gate visible,
    // and the done-criteria shelf.
    await user.click(canvas.getByRole("tab", { name: /Workflow/ }));
    expect(canvas.getByText("Prepare")).toBeInTheDocument();
    expect(canvas.getByText("parallel")).toBeInTheDocument();
    expect(canvas.getByText(/Changes requested/)).toBeInTheDocument();
    expect(canvas.getByText(/back to Elliot · rework budget 2/)).toBeInTheDocument();
    expect(canvas.getByText(/Done when/)).toBeInTheDocument();
    expect(canvas.getByText("Held-out split never seen by the n-gram table")).toBeInTheDocument();

    // Loops tab: the seeded world carries no work tasks, so the empty state shows.
    await user.click(canvas.getByRole("tab", { name: /Loops/ }));
    expect(canvas.getByText("No loops yet. Ask Dana to hand Research Team a task.")).toBeInTheDocument();

    // Escape hands the section back to the two grids.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.getByRole("heading", { name: /Community teams/ })).toBeInTheDocument());
    expect(canvas.queryByRole("heading", { name: "Research Team" })).toBeNull();
  },
};

// -- community ----------------------------------------------------------------

/** The expanded community card: author line, add-from-expanded lands in Your teams. */
export const CommunityTeamAdd: Story = {
  name: "Community team · add from expanded",
  parameters: { router: staticView("teams") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    const openTripCrew = async () => {
      await user.click(canvas.getByText("Plans a trip and keeps it on budget").closest("button") as HTMLElement);
      await waitFor(() => expect(canvas.getByRole("heading", { name: "Trip Crew" })).toBeInTheDocument());
    };
    await openTripCrew();
    expect(canvas.getByText("by @wanderlist")).toBeInTheDocument();

    // Escape closes; the card reopens for the add.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("heading", { name: "Trip Crew" })).toBeNull());
    await openTripCrew();

    // Adding pulls the team into Your teams (members and all) and closes the expansion.
    await user.click(canvas.getByRole("button", { name: "Add to your teams" }));
    await waitFor(() => expect(countChip(canvasElement, /Your teams/)).toBe("3"));
    expect(countChip(canvasElement, /Community teams/)).toBe("2");
    expect(canvas.getByText("From @wanderlist")).toBeInTheDocument(); // provenance pill on the card
    expect(canvas.queryByRole("heading", { name: "Trip Crew" })).toBeNull();
    expect(addButtons(canvasElement).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add Launch Squad to your teams",
      "Add Money Desk to your teams",
    ]);
  },
};

/** The card's plus button adds without expanding anything. */
export const AddCommunityFromCard: Story = {
  name: "Community add from the card",
  parameters: { router: staticView("teams") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Add Launch Squad to your teams" }));

    // Counts move, no expansion opened, the added card grows an "Added by you"-style origin.
    await waitFor(() => expect(countChip(canvasElement, /Your teams/)).toBe("3"));
    expect(countChip(canvasElement, /Community teams/)).toBe("2");
    expect(canvas.queryByRole("heading", { name: /Trip Crew|Launch Squad|Money Desk/ })).toBeNull();
    expect(canvas.getByText("From @shipnotes")).toBeInTheDocument();
    expect(addButtons(canvasElement)).toHaveLength(2);
  },
};

/** Every community team added: the shelf's empty state, yours untouched. */
export const CommunityExhausted: Story = {
  name: "Community exhausted",
  parameters: { router: exhaustedRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(countChip(canvasElement, /Your teams/)).toBe("2");
    await waitFor(() => expect(countChip(canvasElement, /Community teams/)).toBe("0"));
    expect(canvas.getByText("You've added every community team.")).toBeInTheDocument();
    expect(addButtons(canvasElement)).toHaveLength(0);
  },
};

// -- organizations ------------------------------------------------------------

/** The org folder: tab count, Dana at the head, one box per slot, shared members tagged. */
export const OrgChart: Story = {
  name: "Organization chart",
  parameters: { router: { ...staticView("orgs") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByRole("heading", { name: /Your organizations/ })).toBeInTheDocument();
    const folder = canvas.getByRole("button", { name: /Ty's Lab/ });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(folder).toHaveTextContent("2 teams");

    // Head, one box per slot, lead crowned, the twice-membered agent tagged shared.
    expect(canvas.getByText("Dana")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Research Team/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Product Team/ })).toBeInTheDocument();
    expect(canvas.getAllByText(/· Lead/)).toHaveLength(2); // Elliot and Diego
    expect(canvas.getAllByText("shared")).toHaveLength(2); // Jonah, under each box
    expect(canvas.queryByText(/copy \d/)).toBeNull();
    expect(canvas.queryByText(/Add teams to/)).toBeNull(); // editing closed
  },
};

/** Editing: the tab opens the slot editor; remove, add a copy, add a community team; Escape. */
export const OrgEditing: Story = {
  name: "Organization editing · remove, copy, add-from-community",
  parameters: { router: { ...staticView("orgs") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: /Ty's Lab/ }));
    expect(canvas.getByRole("button", { name: /Ty's Lab/ })).toHaveAttribute("aria-expanded", "true");
    expect(canvas.getByText(/Add teams to Ty's Lab/)).toBeInTheDocument();
    expect(canvas.getByText("Pick a team below")).toBeInTheDocument(); // the empty slot
    expect(canvas.getByRole("button", { name: "Remove Research Team from this organization" })).toBeInTheDocument();

    // Remove the research slot: the tab recounts and the box leaves the chart.
    await user.click(canvas.getByRole("button", { name: "Remove Research Team from this organization" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: /1 team$/ })).toBeInTheDocument());
    await waitFor(() => expect(canvas.getAllByRole("button", { name: /· Lead/ })).toHaveLength(1)); // research box left

    // Add a second copy of Product: the row (already in the org) offers "Add copy",
    // the chart grows a "copy 2" box and the row recounts its copies.
    const yourTeams = canvas.getByRole("heading", { name: /Your teams/ }).closest("section") as HTMLElement;
    const productRow = within(yourTeams).getByText("Product Team").closest("li") as HTMLElement;
    expect(within(productRow).getByText(/1 in this org|in this org/)).toBeInTheDocument();
    await user.click(within(productRow).getByRole("button", { name: "Add copy" }));
    await waitFor(() => expect(canvas.getByText("copy 2")).toBeInTheDocument());
    expect(within(productRow).getByText(/2 copies in this org/)).toBeInTheDocument();

    // Adding a community team files it under the org and pulls it into Your teams.
    const community = canvas.getByRole("heading", { name: /Community teams/ }).closest("section") as HTMLElement;
    const tripRow = within(community).getByText("Trip Crew").closest("li") as HTMLElement;
    await user.click(within(tripRow).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(yourTeams).getByText("Trip Crew")).toBeInTheDocument());
    await waitFor(() => expect(within(community).queryByText("Trip Crew")).toBeNull());

    // Escape leaves editing; the chart keeps every slot: research out, product copy and
    // the community add in → 3 teams under the tab.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.getByRole("button", { name: /Ty's Lab/ })).toHaveAttribute("aria-expanded", "false"));
    await waitFor(() => expect(canvas.queryByText(/Add teams to/)).toBeNull());
    expect(canvas.getByRole("button", { name: /3 teams/ })).toBeInTheDocument();
  },
}

/** Clicking a team box in the org jumps to the teams view with that team expanded. */
export const OrgTeamJumpsToTeams: Story = {
  name: "Org team opens in the teams view",
  parameters: { router: crossingRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: /Product Team/ }));

    // The teams view took over: org chart gone, expansion live, both shelves visible.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Product Team" })).toBeInTheDocument());
    await waitFor(() => expect(canvas.queryByRole("heading", { name: /Your organizations/ })).toBeNull());
    expect(canvas.getByRole("heading", { name: /Your teams/ })).toBeInTheDocument();
    // A yours-team is open, so the community shelf is hidden exactly as on a click.
    expect(canvas.queryByRole("heading", { name: /Community teams/ })).toBeNull();
    expect(canvas.getByText("Turns validated findings into product decisions: market fit, scope and a first build.")).toBeInTheDocument();

    // Closing lands on the plain catalog; the selection is gone, not transferred.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("heading", { name: "Product Team" })).toBeNull());
    expect(canvas.getByRole("button", { name: /Research Team/ })).toBeInTheDocument();
  },
};
