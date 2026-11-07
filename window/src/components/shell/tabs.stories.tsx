// Tabs stories (ANY-11 M2): the title-bar tab strip. The strip itself is pure React
// (TabsProvider + registry), so it is executable in Storybook even though its host —
// the Electron title bar — is not (see title-bar.stories.tsx). A memory router backs
// TabsProvider's useLocation/useNavigate.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TabStrip, TabsProvider, useTabs } from "./tabs";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";

// TabStrip opens tooltips; WithHarness first so stores reset before render.
const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Shell/Tabs",
  decorators: [WithHarness, tooltipDecorator],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Drops a chat title onto the first tab — the moment a lone tab becomes visible. */
function ChatTitleSetter() {
  const { tabs, setChatTitle } = useTabs();
  return (
    <button type="button" onClick={() => setChatTitle(tabs[0].id, "Refactor auth")}>
      Start chat
    </button>
  );
}

function LocationProbe() {
  const { pathname } = useLocation();
  return <p data-testid="tabs-location">{`Location: ${pathname}`}</p>;
}

const tabsRoutes = (children: React.ReactNode) => [
  { path: "*", element: <TabsProvider>{children}<LocationProbe /></TabsProvider> },
];

/** A lone tab stays hidden (just the +) until its chat starts — then it names the chat. */
export const LoneTabHiddenUntilChat: Story = {
  name: "Lone tab hidden until chat",
  parameters: { router: { routes: tabsRoutes(<><TabStrip /><ChatTitleSetter /></>) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // No chat yet: no tab strip content, just the "New tab" button.
    expect(canvas.queryByRole("tab")).toBeNull();
    expect(canvas.getByRole("button", { name: "New tab" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(canvas.getByRole("button", { name: "Start chat" }));

    // The lone tab now shows the chat's title with the chat icon.
    const tab = canvas.getByRole("tab", { name: "Refactor auth" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab.querySelector(".lucide-message-square")).not.toBeNull();
  },
};

/** Multiple tabs: each remembers its location, selecting navigates, closing collapses. */
export const MultipleTabsNavigate: Story = {
  name: "Multiple tabs navigate",
  parameters: { router: { routes: tabsRoutes(<TabStrip />), initialEntries: ["/weave"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = () => canvasElement.querySelector("[data-testid=tabs-location]")?.textContent;
    const user = userEvent.setup();

    // Start on Weave: a lone chatless tab is hidden.
    expect(canvas.queryByRole("tab")).toBeNull();

    await user.click(canvas.getByRole("button", { name: "New tab" }));
    // Two tabs now: Weave (carried over) and the new one, which is active on "/".
    const weave = canvas.getByRole("tab", { name: "Weave" });
    const fresh = canvas.getByRole("tab", { name: "New thread" });
    expect(weave.querySelector(".lucide-spool")).not.toBeNull();
    expect(fresh.querySelector(".lucide-square-pen")).not.toBeNull();
    expect(weave).toHaveAttribute("aria-selected", "false");
    expect(fresh).toHaveAttribute("aria-selected", "true");

    // Selecting another tab navigates to its remembered location…
    await user.click(weave);
    await waitFor(() => {
      expect(weave).toHaveAttribute("aria-selected", "true");
      expect(probe()).toBe("Location: /weave");
    });
    expect(canvas.getByRole("tab", { name: "New thread" })).toHaveAttribute("aria-selected", "false");

    // …and closing it leaves a lone chatless tab: hidden again, location unchanged.
    await user.click(canvas.getByRole("button", { name: "Close New thread" }));
    await waitFor(() => expect(canvas.queryByRole("tab")).toBeNull());
    expect(probe()).toBe("Location: /weave");
  },
};
