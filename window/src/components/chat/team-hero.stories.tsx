// Team hero stories (ANY-12 M3): the Teams-mode hero and the team profile card —
// the roster's lead as the portrait, the create-a-team slot at the end of the cycle.
//
// State → story inventory:
//   Team switch: chevrons, the "Brief a team" menu, the create-a-team slot → TeamSwitch
//   Team profile open: Members/Workflow tabs from the fixture team        → TeamProfileOpen

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AgentProfilePanel } from "./assistant-hero";
import { TeamHero, TeamProfile, teamLead } from "./team-hero";
import { profileById, studioTeams } from "@/lib/registry";
import { WithHarness } from "../../../.storybook/harness";

const meta = {
  title: "Chat/TeamHero",
  decorators: [WithHarness],
  parameters: {
    router: { routes: [{ path: "*", element: <TeamHeroHost /> }] },
    a11y: {
      // Scoped exception, token-level: pill labels and tab triggers pair
      // foreground-opacity text below the 4.5:1 bar — the same design tokens
      // studio-ui.stories.tsx scopes out. Fixing means changing the design tokens,
      // outside this card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The team hero beside its profile card, mirroring ThreadBody's Teams-mode wiring. */
function TeamHeroHost({ initialIndex = 0 }: { initialIndex?: number }) {
  const teams = studioTeams();
  const [index, setIndex] = useState(initialIndex);
  const [open, setOpen] = useState(false);
  const team = teams[index];
  const agent = team ? teamLead(team) : profileById("dana").agent;
  return (
    <div className="flex min-h-[480px] w-[720px] items-start justify-center p-8">
      <TeamHero teams={teams} index={index} onIndexChange={setIndex} onProfileToggle={() => setOpen((v) => !v)} />
      <AgentProfilePanel
        agent={agent} open={open} tab="agent" onTabChange={() => { }}
        agentTab={team ? <TeamProfile team={team} /> : undefined} agentTabLabel="Team"
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/** Switching teams: chevrons, the menu, and the trailing create-a-team slot. */
export const TeamSwitch: Story = {
  name: "Team switch",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const user = userEvent.setup();

    expect(canvas.getByRole("img", { name: "Elliot" })).toBeInTheDocument();
    expect(canvas.getByText("Research Team")).toBeInTheDocument();
    expect(canvas.getByText("Team 1 of 3")).toBeInTheDocument();

    // Chevrons cycle the roster; the lead portrait follows the team.
    await user.click(canvas.getByRole("button", { name: "Next team" }));
    expect(canvas.getByText("Product Team")).toBeInTheDocument();
    expect(canvas.getByRole("img", { name: "Diego" })).toBeInTheDocument();

    // The trailing slot hands you to Dana: "Create a team" (its item carries a description).
    await user.click(canvas.getByRole("button", { name: "Switch team (now Product Team)" }));
    await user.click(body.getByRole("menuitem", { name: /Create a team/ }));
    expect(canvas.getByText("Create a team")).toBeInTheDocument();
    expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument();
    expect(canvas.getByText("Team 3 of 3")).toBeInTheDocument();

    await waitFor(() => expect(document.querySelector("[data-slot=dropdown-menu-content]")).toBeNull());
  },
};

/** The team profile card: fixture members with the lead flagged, workflow stages, close. */
export const TeamProfileOpen: Story = {
  name: "Team profile open",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Toggle Research Team's profile" }));
    const panel = canvas.getByRole("complementary", { name: "Elliot's profile" });

    // Header: the team, its lead, its active status.
    expect(within(panel).getByRole("heading", { name: "Research Team" })).toBeInTheDocument();
    expect(within(panel).getByText("Led by Elliot")).toBeInTheDocument();
    expect(within(panel).getByText("Active")).toBeInTheDocument();

    // Members tab (default): the lead carries the Lead pill with his duty beneath.
    expect(within(panel).getByText("Lead")).toBeInTheDocument();
    expect(within(panel).getByText("Plans the experiment and owns rework")).toBeInTheDocument();

    // Workflow tab: the fixture stages, review gate included.
    await user.click(within(panel).getByRole("tab", { name: "Workflow" }));
    expect(within(panel).getByText("Stages")).toBeInTheDocument();
    expect(within(panel).getByText("Validate")).toBeInTheDocument();
    expect(within(panel).getAllByText("Review gate").length).toBeGreaterThan(0);

    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};
