// Studio screen stories (ANY-17 M5, extended by ANY-18): the composed page — header and
// view switch, the ?view= contract (agents default, teams/orgs opt-in), and the ?agent=
// deep link into an expanded profile. Row-level states live in agent-studio.stories.tsx
// (ANY-17) and teams-view.stories.tsx (ANY-18); primitives in studio-ui.stories.tsx.
//
// State → story inventory:
//   agents view (default, no ?view)       → AgentsViewIsDefault
//   view switch teams → orgs → agents, URL contract, pane visibility → SwitchViews
//   ?agent= deep link expands on load     → AgentDeepLink
//   ?view=teams deep link renders the teams catalog → TeamsViewDeepLink (ANY-18)
//   org team box → ?view=teams with the team expanded, selection cleared on close → OrgTeamCrossing (ANY-18)
//
// Recorded exclusions:
//   - The Create button is a static affordance (no handler in production); its per-view
//     label is asserted, its click is not. It renders whenever VITE_DEMO != 1, which is
//     how the stories (and CI) build.
//   - Closing the deep-linked profile leaves ?agent= in the URL (the component keeps the
//     key stable to avoid a remount); asserted as-is in AgentDeepLink.
//   - Teams/orgs pane interiors: cataloged in teams-view.stories.tsx; only visibility,
//     URL contract and the cross-view selection handoff are asserted here.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StudioScreen } from "./studio-screen";

const TooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Studio/Screen",
  component: StudioScreen,
  decorators: [WithHarness, TooltipDecorator],
  parameters: {
    layout: "fullscreen",
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

const routes = [{ path: "/agents", element: <StudioScreen /> }];

/** True when the pane containing `marker` (or an ancestor within a few levels) is
 *  display-hidden — the cross-fade keeps both panes mounted, hidden via the class. */
function paneHidden(root: HTMLElement, marker: RegExp): boolean {
  let el: HTMLElement | null = within(root).getByText(marker).parentElement;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    if (el.classList.contains("hidden")) return true;
  }
  return false;
}

const panelWithPattern = (root: HTMLElement, fragment: string) =>
  Array.from(root.querySelectorAll("div")).find((d) => d.className.includes(fragment));

/** ?view absent: the agents catalog, the header switch on Agents, the Create action. */
export const AgentsViewIsDefault: Story = {
  name: "Agents is the default view",
  parameters: { router: { routes, initialEntries: ["/agents"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Header: title, three-way switch with Agents selected, view-scoped Create.
    expect(canvas.getByText("Agent Studio")).toBeInTheDocument();
    expect(canvas.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    expect(canvas.getByRole("button", { name: "Create agent" })).toBeInTheDocument();

    // Agents pane live, teams pane mounted but hidden behind the cross-fade.
    await waitFor(() => expect(paneHidden(canvasElement, /Agent profiles/)).toBe(false));
    expect(paneHidden(canvasElement, /Your teams/)).toBe(true);
    expect(canvas.getByText("The agents you work with. Dana is your default; the others are specialists she can hand work to.")).toBeInTheDocument();

    // The agents view wears the dots texture.
    expect(panelWithPattern(canvasElement, "bg-[radial-gradient(")).toBeDefined();
  },
};

/** The view switch: ?view=teams / ?view=orgs swap the panes; agents clears the param. */
export const SwitchViews: Story = {
  name: "View switch and URL contract",
  parameters: { router: { routes, initialEntries: ["/agents"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const router = storyRouter();
    if (!router) throw new Error("studio screen play: no active story router");

    await user.click(canvas.getByRole("tab", { name: "Teams" }));
    await waitFor(() => expect(paneHidden(canvasElement, /Agent profiles/)).toBe(true));
    expect(router.state.location.search).toBe("?view=teams");
    expect(paneHidden(canvasElement, /Your teams/)).toBe(false);
    expect(canvas.getByRole("button", { name: "Create team" })).toBeInTheDocument();

    await user.click(canvas.getByRole("tab", { name: "Organizations" }));
    await waitFor(() => expect(router.state.location.search).toBe("?view=orgs"));
    expect(canvas.getByRole("button", { name: "Create organization" })).toBeInTheDocument();
    await waitFor(() => expect(canvas.getByText("Your organizations")).toBeInTheDocument());
    // Non-agents views wear the grid texture.
    expect(panelWithPattern(canvasElement, "bg-[size:24px_24px]")).toBeDefined();

    // Back to Agents: the param is removed, and the catalog is exactly as it was —
    // same nine cards, nothing leaked in or out through the detour.
    await user.click(canvas.getByRole("tab", { name: "Agents" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await waitFor(() => expect(paneHidden(canvasElement, /Agent profiles/)).toBe(false));
    expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9);
    expect(canvas.getByRole("button", { name: "Create agent" })).toBeInTheDocument();
  },
};

/** ?agent=deep link: the named profile starts expanded, communities hidden. */
export const AgentDeepLink: Story = {
  name: "Agent deep link",
  parameters: { router: { routes, initialEntries: ["/agents?agent=jonah"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByRole("heading", { name: "Jonah" })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).toBe("?agent=jonah");
    // A yours-selection hides the community shelf exactly like a click would.
    expect(canvas.queryByText(/Community profiles/)).toBeNull();

    await user.click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9));
    // The param stays: the component keys the pane on it rather than rewriting it.
    expect(storyRouter()!.state.location.search).toBe("?agent=jonah");
  },
};

/** ?view=teams lands directly on the teams catalog — no switch click needed. */
export const TeamsViewDeepLink: Story = {
  name: "Teams view deep link",
  parameters: { router: { routes, initialEntries: ["/agents?view=teams"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // URL-hydrated state: the switch on Teams, teams pane live, agents hidden behind it.
    expect(storyRouter()!.state.location.search).toBe("?view=teams");
    expect(canvas.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
    expect(canvas.getByRole("button", { name: "Create team" })).toBeInTheDocument();
    await waitFor(() => expect(paneHidden(canvasElement, /Your teams/)).toBe(false));
    expect(paneHidden(canvasElement, /Agent profiles/)).toBe(true);

    // The pane body is the real catalog, not a shell.
    expect(canvas.getByRole("heading", { name: /Your teams/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Research Team/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Add Trip Crew to your teams" })).toBeInTheDocument();
  },
};

/** An org's team box hands off across views: ?view=teams with the team expanded. */
export const OrgTeamCrossing: Story = {
  name: "Org team crosses into the teams view",
  parameters: { router: { routes, initialEntries: ["/agents?view=orgs"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const router = storyRouter();
    if (!router) throw new Error("studio screen play: no active story router");

    await waitFor(() => expect(canvas.getByRole("heading", { name: /Your organizations/ })).toBeInTheDocument());
    await user.click(canvas.getByRole("button", { name: /Research Team/ }));

    // The view param flips and the clicked team is expanded inside the teams pane.
    await waitFor(() => expect(router.state.location.search).toBe("?view=teams"));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Research Team" })).toBeInTheDocument());
    expect(paneHidden(canvasElement, /Agent profiles/)).toBe(true);
    expect(canvas.getByRole("link", { name: /Elliot/ })).toHaveAttribute("href", "/agents?agent=elliot");

    // Closing the expansion keeps the view; the org's copy of the selection is gone with it.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("heading", { name: "Research Team" })).toBeNull());
    expect(router.state.location.search).toBe("?view=teams");
    expect(canvas.getByRole("button", { name: /Product Team/ })).toBeInTheDocument(); // plain card again

    // Back to the org: the chart is intact, no stale expansion, still two slots.
    await user.click(canvas.getByRole("tab", { name: "Organizations" }));
    await waitFor(() => expect(router.state.location.search).toBe("?view=orgs"));
    await waitFor(() => expect(canvas.getByRole("button", { name: /Ty's Lab/ })).toHaveTextContent("2 teams"));
    expect(canvas.queryByText(/Add teams to/)).toBeNull();
  },
};
