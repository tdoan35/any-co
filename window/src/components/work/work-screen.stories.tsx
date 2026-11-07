// Composed Work screen stories (ANY-19 M6): the real route — loader, stores, search-param
// contract — mounted in the harness memory router exactly as routes/work.tsx declares it.
//
// State → story inventory (screen level; card/board internals live in the co-located files):
//   ?project deep link      → ProjectDeepLink (play: board → team chip → teams lens →
//                             Projects tab → index; the URL follows every hop)
//   lens switch             → LensSwitch (play: Teams ⇄ Projects on the real segmented
//                             control, data loaded once, no reload between)
//   ?…&tab=history          → HistoryDeepLink (the ledger, straight from the URL)
//   ?scope=archived         → covered on Work/Board (Archived project · empty board) —
//                             the screen adds no state of its own beyond the URL
//   new project             → NewProjectLandsEmpty (play: dialog → create → revalidate →
//                             the brand-new project's empty board)
//   ?view=teams&team=… deep link → exercised by the board file's chip click above
//
// The loader runs against the mock API (no server; the harness guard would block one)
// and `shouldRevalidate` is the production one, so search-only hops reuse the data.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkPage, workLoader, workShouldRevalidate } from "../../routes/work";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const VIEWPORTS = {
  wide: { name: "Wide · screen", styles: { width: "1600px", height: "1000px" } },
} as const;

const meta = {
  title: "Work/Screen",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
    a11y: {
      // Scoped exception, token-level like every prior file: muted-foreground header
      // text and warn pills on translucent panels sit below the 4.5:1 bar — the same
      // design tokens the Weave/chat/studio cards scoped out. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const workRoute = { path: "/work", element: <WorkPage />, loader: workLoader, shouldRevalidate: workShouldRevalidate };
const screen = (initialEntry: string) => ({
  viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  router: { routes: [workRoute], initialEntries: [initialEntry] },
});

const rowByName = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLAnchorElement>("li > a")].find((a) => a.textContent?.includes(name));

// ---- deep link into a project ----

/** ?project renders the board with no clicks; the team chip crosses to the lens; Projects comes back. */
export const ProjectDeepLink: Story = {
  name: "Deep link · project, team chip, back to index",
  parameters: screen("/work?project=engram"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Loaded straight from the loader: breadcrumb, four columns, the sticky head.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Engram on small models" })).toBeInTheDocument());
    expect(canvasElement.querySelector("div.sticky")).not.toBeNull();

    // The team chip is a lens crossing, not a reload: ?view=teams&team=research.
    await user.click(canvas.getByRole("link", { name: /Research Team/ }));
    await waitFor(() => expect(canvasElement.querySelector('section[aria-label="Implement"]')).not.toBeNull());
    expect(storyRouter()!.state.location.search).toBe("?view=teams&team=research");

    // …and the real segmented control walks the lens back to the index (the team param
    // stays, exactly as the board's set() leaves it).
    await user.click(canvas.getByRole("tab", { name: "Projects" }));
    await waitFor(() => expect(rowByName(canvasElement, "Engram on small models")).toBeTruthy());
    expect(storyRouter()!.state.location.search).toBe("?team=research");
  },
};

// ---- lens switch on the mounted screen ----

/** The lens toggle swaps index ⇄ teams in place; the loader data survives the hop. */
export const LensSwitch: Story = {
  name: "Lens · Teams and back, data unchanged",
  parameters: screen("/work"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(rowByName(canvasElement, "Engram on small models")).toBeTruthy());
    await user.click(canvas.getByRole("tab", { name: "Teams" }));
    await waitFor(() => expect(canvasElement.querySelector('section[aria-label="Plan"]')).not.toBeNull());
    expect(storyRouter()!.state.location.search).toBe("?view=teams");

    // The team lens defaults to the first team; the loop counter reads the seeded runs.
    expect(canvasElement.textContent).toContain("3 tasks, 4 loops");

    await user.click(canvas.getByRole("tab", { name: "Projects" }));
    await waitFor(() => expect(rowByName(canvasElement, "Product exploration")).toBeTruthy());
    expect(storyRouter()!.state.location.search).toBe("");
  },
};

// ---- history deep link ----

/** ?tab=history lands on the ledger with no clicks — same two loops the board link reaches. */
export const HistoryDeepLink: Story = {
  name: "Deep link · history tab",
  parameters: screen("/work?project=engram&tab=history"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Previous loops")).toBeInTheDocument());
    expect(canvasElement.querySelectorAll("li > a")).toHaveLength(2);
    expect(canvas.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
    const texts = [...canvasElement.querySelectorAll("li > a")].map((a) => a.textContent ?? "").join(" ");
    expect(texts).toContain("NAND latency probe");
    expect(texts).toContain("n-gram fusion on a 135M model");
  },
};

// ---- new project ----

/** The dialog creates for real: the mock API answers, the loader revalidates, and the brand-empty board opens. */
export const NewProjectLandsEmpty: Story = {
  name: "New project · create lands on the empty board",
  parameters: screen("/work"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await waitFor(() => expect(rowByName(canvasElement, "Engram on small models")).toBeTruthy());
    await user.click(canvas.getByRole("button", { name: "New project" }));
    const dialog = await within(document.body).findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Create project" });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByPlaceholderText("Engram on small models"), "Tokenizer regression");
    expect(submit).toBeEnabled();
    await user.click(submit);

    // The router navigates and the revalidated data carries the new project's empty board.
    await waitFor(() => expect(storyRouter()!.state.location.search).toBe("?project=tokenizer-regression"));
    await waitFor(() =>
      expect(
        canvas.queryByText(/No work in this project yet\. Ask Dana in one of its threads, and her proposal lands here\./),
      ).toBeInTheDocument(),
    );
    expect(canvas.getByRole("heading", { name: "Tokenizer regression" })).toBeInTheDocument();

    // The dialog is gone and the index, on the way back, knows the new project.
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
    await user.click(canvas.getByRole("link", { name: "Work" }));
    await waitFor(() => expect(rowByName(canvasElement, "Tokenizer regression")).toBeTruthy());
  },
};
