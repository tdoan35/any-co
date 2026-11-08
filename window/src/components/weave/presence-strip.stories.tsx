// Presence strip stories: the "Now" block at the top of Weave's inbox — the single
// row's urgency order (waiting → blocked → working), idle folded into the summary line
// until "N idle" is clicked, and the two selection seams (a waiting agent opens its
// item; anyone else opens Agent Studio).
//
// State → story inventory (all PresenceStates; none excluded):
//   waiting   elliot, jonah (with itemIds) → UrgencyAndIdleFold (play: selecting a
//             waiting agent opens its item)
//   working   elliot, jonah (seeded snapshot) → WorkingAgents (order + sub-label)
//   blocked   sana                         → both stories (sub-label asserted)
//   idle      megan, carlos, diego, lila, maya
//                                          → folded until "5 idle" is clicked ·
//                                             IdleAgentNavigates
//   empty presence []                     → EveryoneIdle
//
// Documented exclusions:
//   - The strip's chevron paging is not asserted: it only appears when the row
//     overflows, which depends on the pixel width of seeded faces — a layout
//     coincidence, not a state. Reveal (the state-driven affordance) is asserted.

import { useState } from "react";
import type { RouteObject } from "react-router";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setWeaveSnapshot, useWeave } from "@/lib/weave-store";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed } from "@fabric/fixtures/weave";
import { PresenceStrip } from "./presence-strip";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Weave/Presence strip",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like the other Weave files: muted-foreground text
      // on translucent panels sits below the 4.5:1 bar — the same design tokens the
      // prior cards scoped out. Fixing means changing the design tokens, outside this
      // card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Stands the strip up against the seeded store at the inbox column's width. `picked`
 * records onSelectItem calls so the item-selection seam is assertable. The strip needs
 * a router (a non-waiting face navigates to Agent Studio), so every story declares one.
 */
function StripPane({ prepare }: { prepare?: () => void }) {
  useState(() => { prepare?.(); });
  const state = useWeave();
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="w-[300px] border-r border-foreground/10 bg-background/40">
      <PresenceStrip presence={state.presence} onSelectItem={(id) => setPicked((p) => [...p, `item:${id}`])} />
      <div data-testid="picked">{picked.join(" ")}</div>
    </div>
  );
}

const stripRoutes = (prepare?: () => void): { router: { routes: RouteObject[] } } => ({
  router: { routes: [{ path: "*", element: <StripPane prepare={prepare} /> }] },
});

/** Urgency order (waiting → blocked; no working agents in the seed), idle counted in the summary. */
export const UrgencyAndIdleFold: Story = {
  name: "Urgency order · idle folded into the summary",
  parameters: stripRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Waiting on you first, then blocked; the five idles are folded away but counted.
    expect(canvas.getByText(/2 waiting on you · 1 blocked/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "5 idle" })).toBeInTheDocument();
    const agentIds = () => [...canvasElement.querySelectorAll("[data-agent]")].map((el) => el.getAttribute("data-agent"));
    expect(agentIds()).toEqual(["elliot", "jonah", "sana"]);
    expect(canvas.getAllByText("Needs you")).toHaveLength(2);
    expect(canvas.getByText("Blocked")).toBeInTheDocument();

    // Selecting a waiting agent opens the item it is waiting on.
    await user.click(canvas.getByRole("button", { name: /^Elliot/ }));
    expect(canvasElement.querySelector("[data-testid='picked']")!.textContent).toContain("item:seed-count");

    // "5 idle" reveals the idles at the end of the row and toggles back.
    const idleToggle = canvas.getByRole("button", { name: "5 idle" });
    expect(idleToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(idleToggle);
    expect(idleToggle).toHaveAttribute("aria-pressed", "true");
    expect(agentIds()).toEqual(["elliot", "jonah", "sana", "megan", "carlos", "diego", "lila", "maya"]);
    expect(canvas.getAllByText("Idle")).toHaveLength(5);
    await user.click(idleToggle);
    expect(idleToggle).toHaveAttribute("aria-pressed", "false");
    expect(agentIds()).toEqual(["elliot", "jonah", "sana"]);
  },
};

/** Working agents sit after blocked in the row, and the summary counts all three states. */
export const WorkingAgents: Story = {
  name: "Working agents · after blocked",
  parameters: stripRoutes(() => setWeaveSnapshot({
    items: inboxSeed,
    pulse: pulseSeed,
    calendar: calendarEvents,
    presence: [
      { agentId: "elliot", state: "working", activity: "Run · 360M training", since: "2026-10-02T10:56:00-07:00" },
      { agentId: "jonah", state: "working", activity: "Implement · data pipeline", since: "2026-10-02T11:08:00-07:00" },
      { agentId: "sana", state: "blocked", activity: "Prep checks · waiting for the C4 shard", since: "2026-10-02T11:10:00-07:00" },
      ...presenceSeed.filter((p) => p.state === "idle"),
    ],
  })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/2 working · 1 blocked/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "5 idle" })).toBeInTheDocument();
    const agentIds = [...canvasElement.querySelectorAll("[data-agent]")].map((el) => el.getAttribute("data-agent"));
    expect(agentIds).toEqual(["sana", "elliot", "jonah"]);
    expect(canvas.getAllByText("Working")).toHaveLength(2);
    expect(canvas.getByText("Blocked")).toBeInTheDocument();
  },
};

/** An idle agent has no item to open: selecting one navigates to Agent Studio. */
export const IdleAgentNavigates: Story = {
  name: "Idle agent · navigates to Agent Studio",
  parameters: stripRoutes(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "5 idle" }));
    await user.click(canvas.getByRole("button", { name: /^Diego/ }));
    await waitFor(() => expect(storyRouter()!.state.location.pathname).toBe("/agents"));
    expect(storyRouter()!.state.location.search).toBe("?agent=diego");
  },
};

/** No presence at all: the calm one-liner, no toggle, no faces. */
export const EveryoneIdle: Story = {
  name: "Everyone idle",
  parameters: stripRoutes(() => setWeaveSnapshot({ items: inboxSeed, pulse: pulseSeed, presence: [], calendar: calendarEvents })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Everyone is idle.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: /idle/ })).toBeNull();
    expect(canvasElement.querySelector("[data-agent]")).toBeNull();
  },
};
