// Agent hero stories (ANY-12 M3): the empty-chat hero and its right-hand profile card.
// States are driven through the hero's own affordances — chevrons, keyboard, the
// switch menu and the portrait click — on the seeded registry fixtures.
//
// State → story inventory:
//   Agent switch: chevrons, Arrow keys (incl. wrap), "Talk to" menu jump → AgentSwitch
//   Profile open: Profile/Capabilities/Memory tabs, Escape to close       → AgentProfileOpen

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AgentHero, AgentProfilePanel, type SideTab } from "./assistant-hero";
import { chatAgents } from "@/lib/registry";
import { WithHarness } from "../../../.storybook/harness";

const meta = {
  title: "Chat/AgentHero",
  decorators: [WithHarness],
  parameters: {
    router: { routes: [{ path: "*", element: <AgentHeroHost /> }] },
    a11y: {
      // Scoped exception, token-level: inactive tab triggers and pill labels pair
      // foreground-opacity text below the 4.5:1 bar — the same design tokens
      // studio-ui.stories.tsx scopes out. Fixing means changing the design tokens,
      // outside this card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The hero beside its profile card, with the toggle state the chat screen would own. */
function AgentHeroHost({ initialIndex = 0 }: { initialIndex?: number }) {
  const agents = chatAgents();
  const [index, setIndex] = useState(initialIndex);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SideTab>("agent");
  return (
    <div className="flex min-h-[480px] w-[720px] items-start justify-center p-8">
      <AgentHero agents={agents} index={index} onIndexChange={setIndex} onProfileToggle={() => setOpen((v) => !v)} />
      <AgentProfilePanel agent={agents[index]} open={open} tab={tab} onTabChange={setTab} onClose={() => setOpen(false)} />
    </div>
  );
}

/** Switching agents: chevrons, arrow keys from the portrait, and the menu jump. */
export const AgentSwitch: Story = {
  name: "Agent switch",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const user = userEvent.setup();

    expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument();

    // Arrow left from the first agent wraps to the last.
    canvas.getByRole("button", { name: "Toggle Dana's profile" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(canvas.getByRole("img", { name: "Carlos" })).toBeInTheDocument();
    expect(canvas.getByText("Agent 4 of 4")).toBeInTheDocument();

    // Chevrons step forward, back onto Dana and on to Jonah.
    await user.click(canvas.getByRole("button", { name: "Next agent" }));
    expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument();
    expect(canvas.getByText("Agent 1 of 4")).toBeInTheDocument();
    await user.click(canvas.getByRole("button", { name: "Next agent" }));
    expect(canvas.getByRole("img", { name: "Jonah" })).toBeInTheDocument();

    // The "Talk to" menu jumps straight to a pick.
    await user.click(canvas.getByRole("button", { name: "Switch agent (now Jonah)" }));
    await user.click(body.getByRole("menuitem", { name: /Megan/ }));
    expect(canvas.getByRole("img", { name: "Megan" })).toBeInTheDocument();
    expect(canvas.getByText("Agent 3 of 4")).toBeInTheDocument();

    // No menu portal left behind for the next story.
    await waitFor(() => expect(document.querySelector("[data-slot=dropdown-menu-content]")).toBeNull());
  },
};

/** The profile card: fixture-true tabs, and Escape (or the close button) hands back. */
export const AgentProfileOpen: Story = {
  name: "Agent profile open",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Toggle Dana's profile" }));
    const panel = canvas.getByRole("complementary", { name: "Dana's profile" });

    // Header from the fixture agent.
    expect(within(panel).getByRole("heading", { name: "Dana" })).toBeInTheDocument();
    expect(within(panel).getByText("Executive assistant")).toBeInTheDocument();

    // Profile tab: her summary and the studio link.
    expect(within(panel).getByText("Your single point of contact. Decides whether to answer, ask, or delegate, and proposes specialists and teams for you to approve.")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Edit in Agent Studio" })).toHaveAttribute("href", "/agents?agent=dana");

    // Memory tab: the four fixture memories (no ids seeded, so no Forget affordances)
    // and the scope block with the agent's context size.
    await user.click(within(panel).getByRole("tab", { name: /Memory/ }));
    expect(within(panel).getByText("Doesn't want meetings booked before 10am.")).toBeInTheDocument();
    expect(within(panel).getAllByText(/^Chat · /).length).toBe(3);
    expect(within(panel).getByText("Typical context")).toBeInTheDocument();
    expect(within(panel).getByText("2,140 tokens")).toBeInTheDocument();

    // Capabilities tab: fixture tools with their policy chips.
    await user.click(within(panel).getByRole("tab", { name: /Capabilities/ }));
    expect(within(panel).getByText("propose_team")).toBeInTheDocument();
    expect(within(panel).getAllByText("allowed").length).toBeGreaterThan(0);

    // Escape closes the panel (it listens on the window while open).
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};
