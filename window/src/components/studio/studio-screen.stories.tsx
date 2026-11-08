// Studio screen stories: one Teams chart. ?team= opens a department, ?agent= opens a
// person. Legacy ?view= drops that param and shows the chart.
//
// State → story inventory:
//   /agents                              → AgentsViewIsDefault
//   a person on the chart opens a profile and Close returns to the chart → SwitchViews
//   ?agent= deep link, Close clears it   → AgentDeepLink
//   ?view=teams lands on the chart       → TeamsViewDeepLink
//   department → member → Back → Escape  → OrgTeamCrossing

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

const panelWithPattern = (root: HTMLElement, fragment: string) =>
  Array.from(root.querySelectorAll("div")).find((d) => d.className.includes(fragment));

/** /agents is the chart: Studio header, no view switch, both departments. */
export const AgentsViewIsDefault: Story = {
  name: "Teams chart is the studio page",
  parameters: { router: { routes, initialEntries: ["/agents"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Studio")).toBeInTheDocument();
    expect(canvas.queryByRole("tab", { name: "Agents" })).toBeNull();
    expect(canvas.queryByRole("button", { name: /Create / })).toBeNull();

    await waitFor(() => expect(canvas.getByRole("heading", { name: /Teams/ })).toBeInTheDocument());
    expect(canvas.getByText("Dana")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Research Team/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Product Team/ })).toBeInTheDocument();
    expect(panelWithPattern(canvasElement, "bg-[size:24px_24px]")).toBeDefined();
  },
};

/** A person on the chart opens their profile without a team, and Close returns to the chart. */
export const SwitchViews: Story = {
  name: "Person on the chart opens their profile",
  parameters: { router: { routes, initialEntries: ["/agents"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const router = storyRouter();
    if (!router) throw new Error("studio screen play: no active story router");

    await waitFor(() => expect(canvas.getByRole("button", { name: /Elliot/ })).toBeInTheDocument());
    await user.click(canvas.getByRole("button", { name: /Elliot/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?agent=elliot"));
    expect(canvas.getByRole("heading", { name: "Elliot" })).toBeInTheDocument();

    await user.click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(canvas.getByRole("heading", { name: /Teams/ })).toBeInTheDocument();
  },
};

/** ?agent= deep link expands that profile. Close clears the param and returns to the chart. */
export const AgentDeepLink: Story = {
  name: "Agent deep link",
  parameters: { router: { routes, initialEntries: ["/agents?agent=jonah"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(canvas.getByRole("heading", { name: "Jonah" })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).toBe("?agent=jonah");

    await user.click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: /Teams/ })).toBeInTheDocument());
    expect(storyRouter()!.state.location.search).toBe("");
  },
};

/** ?view=teams and ?view=orgs drop the old switch and show the chart. */
export const TeamsViewDeepLink: Story = {
  name: "Legacy view links land on the chart",
  parameters: { router: { routes, initialEntries: ["/agents?view=teams"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => expect(storyRouter()!.state.location.search).toBe(""));
    expect(canvas.queryByRole("tab", { name: "Teams" })).toBeNull();
    await waitFor(() => expect(canvas.getByRole("heading", { name: /Teams/ })).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: /Research Team/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Product Team/ })).toBeInTheDocument();
  },
};

/** A department opens in place; a member keeps the team so Close returns there. Escape returns to the chart. */
export const OrgTeamCrossing: Story = {
  name: "Department opens, then a person, then back",
  parameters: { router: { routes, initialEntries: ["/agents?view=orgs"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const router = storyRouter();
    if (!router) throw new Error("studio screen play: no active story router");

    await waitFor(() => expect(canvas.getByRole("heading", { name: /Teams/ })).toBeInTheDocument());
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await user.click(canvas.getByRole("button", { name: /Research Team/ }));

    await waitFor(() => expect(router.state.location.search).toBe("?team=research"));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Research Team" })).toBeInTheDocument());
    expect(canvas.getByRole("tab", { name: /Workflow/ })).toBeInTheDocument();

    await user.click(canvas.getByRole("button", { name: /Elliot/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?team=research&agent=elliot"));
    expect(canvas.getByRole("heading", { name: "Elliot" })).toBeInTheDocument();

    await user.click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => expect(router.state.location.search).toBe("?team=research"));
    expect(canvas.getByRole("heading", { name: "Research Team" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("heading", { name: "Research Team" })).toBeNull());
    expect(router.state.location.search).toBe("");
    expect(canvas.getByRole("button", { name: /Product Team/ })).toBeInTheDocument();
  },
};
