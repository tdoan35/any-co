// Agent Studio stories (ANY-17 M5): the profile catalog itself — your agents' carousel,
// the community grid, the expanded profile and its detail tabs, and both add paths.
// The composed page (header, ?view / ?agent wiring) lives in studio-screen.stories.tsx;
// the shared primitives were cataloged in studio-ui.stories.tsx (M0).
//
// State → story inventory:
//   catalog: carousel + community grid, counts, default pill, install formatting → AgentCatalog
//   expanded owned profile, Files tab, close via the close button → OwnedProfileFiles
//   expanded owned profile, Capabilities/Memory tabs, close via Escape → OwnedProfileDetailTabs
//   expanded community profile (author, empty memory), Escape close, add from expanded → CommunityProfile
//   community add from the grid's plus button → AddCommunityFromCard
//   community exhausted ("added every community profile", seeded empty) → CommunityExhausted
//   expanded on load via the initialId prop → PreselectedProfile
//
// Recorded exclusions:
//   - Carousel edge fade and chevron paging: layout-coincidence, no distinct visible
//     state at story width; the scroll container is exercised implicitly by the counts.
//   - Forget buttons on the Memory tab: no seeded memory carries an id (seeded JSON is
//     read-only by design), so the rows render without the affordance; the button's
//     absence is asserted in OwnedProfileDetailTabs instead of a synthesized decide flow.
//   - The add lives in AgentStudio-local state (localAdds), so it cannot leak into
//     another story; the harness additionally reseeds every store on each story mount.

import { useState } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setRegistry } from "@/lib/registry";
import { storyRegistry } from "@/testing/seed";
import { AgentStudio } from "./agent-studio";

const TooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Studio/Agent studio",
  component: AgentStudio,
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

/** The count chip inside a SectionHead — the section's live record count. */
const countChip = (root: HTMLElement, heading: RegExp) =>
  within(root).getByRole("heading", { name: heading }).querySelector("span")!.textContent;

/** The community grid's per-card add button (absent-safe). */
const addButtons = (root: HTMLElement) =>
  within(root).queryAllByRole("button", { name: / to your agents$/ });

/** The catalog with the community shelf emptied — the "added every profile" state.

 *  Seeds during render, after the harness's reset, so the stage mounts pre-exhausted. */
function CommunityEmptyStage() {
  useState(() => setRegistry({ ...storyRegistry(), communityAgents: [] }));
  return <AgentStudio />;
}

// -- catalog ---------------------------------------------------------------

/** Both sections side by side: nine of yours in the carousel, five community cards. */
export const AgentCatalog: Story = {
  name: "Agent catalog",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Section heads carry the live counts and the standing hints.
    expect(countChip(canvasElement, /Agent profiles/)).toBe("9");
    expect(countChip(canvasElement, /Community profiles/)).toBe("5");
    expect(canvas.getByText("The agents you work with. Dana is your default; the others are specialists she can hand work to.")).toBeInTheDocument();
    expect(canvas.getByText("Profiles shared by others. Added agents start with an empty memory.")).toBeInTheDocument();

    // Your section: one carousel card per profile, Dana flagged as the default.
    expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9);
    const danaCard = canvas.getByText("Your single point of contact").closest("[data-profile]") as HTMLElement;
    expect(danaCard.querySelector("span")?.textContent).toBe("Default");
    expect(within(danaCard).getByText("Executive assistant")).toBeInTheDocument();

    // Community section: author, install-count formatting (1.2k / 3.3k) and the add buttons.
    expect(canvas.getByText("@wanderlist · 1.2k added")).toBeInTheDocument();
    expect(canvas.getByText("@inkwell · 3.3k added")).toBeInTheDocument();
    expect(addButtons(canvasElement).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add Nadine to your agents",
      "Add Yuki to your agents",
      "Add Bea to your agents",
      "Add Nikhil to your agents",
      "Add Rosa to your agents",
    ]);
    expect(canvas.getByRole("button", { name: /Nadine Travel planner/ })).toBeInTheDocument();
  },
};

// -- expanded owned profile ------------------------------------------------

/** Opening a yours-card expands it in place; the community shelf fades out; close returns. */
export const OwnedProfileFiles: Story = {
  name: "Owned profile · files tab",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByText("Writes and runs code in a sandbox").closest("[data-profile]") as HTMLElement);

    // Expanded in place: the community shelf is gone while a yours-card is open.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Jonah" })).toBeInTheDocument());
    await waitFor(() => expect(canvas.queryByText(/Community profiles/)).toBeNull());

    // Files tab (default): the three workspace files, SOUL.md active, body rendered.
    expect(canvas.getByRole("button", { name: /SOUL\.md/ })).toHaveAttribute("data-active", "true");
    expect(canvas.getByRole("button", { name: /IDENTITY\.md/ })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /USER\.md/ })).toBeInTheDocument();
    await waitFor(() => expect(canvasElement.textContent).toContain("You are Jonah, the"));

    // Switching the active file swaps the preview (and its token count) with it.
    await user.click(canvas.getByRole("button", { name: /IDENTITY\.md/ }));
    await waitFor(() => expect(canvasElement.textContent).toContain("Member of: Research Team, Product Team."));
    expect(canvas.getByRole("button", { name: /SOUL\.md/ })).toHaveAttribute("data-active", "false");

    // The close button hands the section back to the carousel.
    await user.click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => {
      expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9);
      expect(canvas.getByRole("heading", { name: /Community profiles/ })).toBeInTheDocument();
    });
  },
};

/** The detail tabs: Capabilities (skills / tools / connectors) and Memory; Escape closes. */
export const OwnedProfileDetailTabs: Story = {
  name: "Owned profile · detail tabs, Escape closes",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByText("Plans the experiment, owns the outcome").closest("[data-profile]") as HTMLElement);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Elliot" })).toBeInTheDocument());
    expect(canvas.getByText("Created in chat · today")).toBeInTheDocument(); // origin pill

    // Capabilities: skills, tools with their policy chips, the connector state.
    await user.click(canvas.getByRole("tab", { name: "Capabilities" }));
    expect(canvas.getByText("experiment-plan")).toBeInTheDocument();
    expect(canvas.getByText("Hypothesis, baselines, criteria, steps.")).toBeInTheDocument();
    expect(canvas.getByText("artifacts.read")).toBeInTheDocument();
    expect(canvas.getAllByText("allowed")).toHaveLength(3);
    expect(canvas.getByText("Neon")).toBeInTheDocument();
    expect(canvas.getByText("Connected")).toBeInTheDocument();

    // Memory: the run-learned row with its provenance, no Forget (seeded rows are
    // read-only), and the scope panel with the context budget.
    await user.click(canvas.getByRole("tab", { name: /^Memory/ }));
    expect(canvas.getByText("Re-planned run #12 after Carlos flagged split overlap; switched to a held-out corpus.")).toBeInTheDocument();
    expect(canvas.getByText("Run #12 · Sep 29")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Forget" })).toBeNull();
    expect(canvas.getByText("Team-scoped · no personal memory")).toBeInTheDocument();
    expect(canvas.getByText("4,200 tokens")).toBeInTheDocument();

    // Escape closes the expanded profile from the keyboard.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9));
  },
};

// -- community -------------------------------------------------------------

/** Community profile expanded: author line, empty memory shelf, Escape-close, add. */
export const CommunityProfile: Story = {
  name: "Community profile · empty memory, add",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: /Nadine Travel planner/ }));
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Nadine" })).toBeInTheDocument());
    expect(canvas.getByText("· by @wanderlist")).toBeInTheDocument();
    expect(canvas.getByText("Upbeat")).toBeInTheDocument();
    await waitFor(() => expect(canvas.queryByText("Default")).toBeNull());

    // Community profiles arrive with no memories: the tab says so, count zero.
    await user.click(canvas.getByRole("tab", { name: /^Memory/ }));
    expect(canvas.getByText("No memories yet. Nadine starts remembering once you add them.")).toBeInTheDocument();
    expect(canvas.getByText("Starts empty when added")).toBeInTheDocument();
    expect(canvas.getByText("1,800 tokens")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add Nadine to your agents" })).toBeInTheDocument());

    // …and the expanded card's own add button pulls her into your carousel.
    await user.click(canvas.getByRole("button", { name: /Nadine Travel planner/ }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add to your agents" })).toBeInTheDocument());
    await user.click(canvas.getByRole("button", { name: "Add to your agents" }));
    await waitFor(() => expect(canvasElement.querySelector('[data-profile="nadine"]')).not.toBeNull());
    await waitFor(() => expect(countChip(canvasElement, /Agent profiles/)).toBe("10"));
    expect(countChip(canvasElement, /Community profiles/)).toBe("4");
  },
};

/** The grid's plus button adds without opening the profile. */
export const AddCommunityFromCard: Story = {
  name: "Community add from the card",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Add Bea to your agents" }));

    // Bea moves to the end of your carousel; the community shelf shrinks by one.
    await waitFor(() => expect(canvasElement.querySelector('[data-profile="bea"]')).not.toBeNull());
    await waitFor(() => expect(countChip(canvasElement, /Agent profiles/)).toBe("10"));
    expect(countChip(canvasElement, /Community profiles/)).toBe("4");
    expect(canvas.queryByRole("button", { name: "Add Bea to your agents" })).toBeNull();
    expect(addButtons(canvasElement)).toHaveLength(4);
  },
};

/** Every community profile added: the shelf's empty state, yours untouched. */
export const CommunityExhausted: Story = {
  name: "Community exhausted",
  render: () => <CommunityEmptyStage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(countChip(canvasElement, /Agent profiles/)).toBe("9");
    await waitFor(() => expect(countChip(canvasElement, /Community profiles/)).toBe("0"));
    expect(canvas.getByText("You've added every community profile.")).toBeInTheDocument();
    expect(addButtons(canvasElement)).toHaveLength(0);
    expect(canvasElement.querySelectorAll("[data-profile]")).toHaveLength(9);
  },
};

/** A deep-linked selection (the ?agent= param's prop) is expanded on first paint. */
export const PreselectedProfile: Story = {
  name: "Preselected via initialId",
  render: () => <AgentStudio initialId="megan" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Expanded without a single click; the community shelf hidden while selected.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Megan" })).toBeInTheDocument());
    expect(canvas.getByText("Searches papers and projects with Exa and turns what she finds into a short survey, with every claim traced to a source.")).toBeInTheDocument();
    await waitFor(() => expect(canvas.queryByText(/Community profiles/)).toBeNull());

    await userEvent.setup().click(canvas.getByRole("button", { name: "Close profile" }));
    await waitFor(() => expect(canvasElement.querySelector('[data-profile="megan"]')).not.toBeNull());
  },
};
