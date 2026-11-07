// Work board stories (ANY-19 M6): the board's own states — project index (active/archived,
// search, waiting-on-you ordering), a project's board columns, the teams lens, and the
// empty board. Card-level states live in the co-located Task card file; the ledger in
// History; the composed screen's URL contract in Work/Screen.
//
// State → story inventory:
//   project index, needs-you order → ProjectIndexWaitingOnYou (play: search no-match,
//                                    Escape restores, archived scope reveals Tokenizer)
//   project index, empty archive   → EmptyArchivedScope (play: the dashed empty message)
//   project board                  → ProjectBoardColumns (play: 1/1/1/1 columns, History
//                                    tab and back via the real segmented control)
//   project board, empty           → covered on the screen file's new-project story and
//                                    archived board below (both real empty paths)
//   archived project's board       → ArchivedProjectBoard (play: row click → empty board)
//   teams lens, occupied steps     → TeamsLensSteps (play: step counts, member strip)
//   teams lens, proposed + empty   → same story, Product Team side (Proposed appears)
//   done cap ("Show all N")        → not reachable: no project has >3 done loops in the
//                                    seeded world (1 max) — documented exclusion
//   order dropdown (needs/recent/name) → exercised only by its default; the menu is a
//                                    plain radix list on the index header, no state of
//                                    its own beyond selection — documented exclusion
//
// Data is the typed fixture world passed straight to `WorkBoard` (the same arrays the
// route loader would hand it); stores come from the harness seed.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { projects as allProjects } from "@fabric/fixtures/sessions";
import { runs as fixtureRuns, tasks as fixtureTasks } from "@fabric/fixtures/work";
import { WorkBoard } from "./board";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const VIEWPORTS = {
  wide: { name: "Wide · board", styles: { width: "1600px", height: "1000px" } },
} as const;

const meta = {
  title: "Work/Board",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
    a11y: {
      // Scoped exception, token-level like every prior file: muted-foreground text and
      // warn pills on translucent panels sit below the 4.5:1 bar — the same design
      // tokens the Weave/chat/studio cards scoped out. Fixing means changing the design
      // tokens, outside this card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const boardRoutes = { routes: [{ path: "/work", element: <WorkBoard projects={allProjects} tasks={fixtureTasks} runs={fixtureRuns} /> }], initialEntries: ["/work"] };
const wide = { viewport: { defaultViewport: "wide", viewports: VIEWPORTS } };

const rowByName = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLAnchorElement>("li > a")].find((a) => a.textContent?.includes(name));

// ---- project index ----

/** The index leads with the project that needs you (5 waiting), search filters it, Escape restores, Archived reveals the quiet project. */
export const ProjectIndexWaitingOnYou: Story = {
  name: "Project index · needs-you order, search, archived",
  parameters: { ...wide, router: boardRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Header facts across the whole board, and the needs-you-first row order.
    expect(canvasElement.querySelector("header")!.textContent).toContain("2 in flight");
    expect(canvasElement.querySelector("header")!.textContent).toContain("5 waiting on you");
    const rows = () => [...canvasElement.querySelectorAll("li > a")].map((a) => a.querySelector("span")!.textContent ?? "");
    expect(rows()[0]).toContain("Engram on small models");
    expect(rowByName(canvasElement, "Engram on small models")!.textContent).toContain("5 waiting on you");
    expect(rowByName(canvasElement, "Engram on small models")!.textContent).toContain("4 tasks · 1 done");
    expect(rowByName(canvasElement, "Product exploration")!.textContent).toContain("No work yet");

    // Search narrows, and an empty result says so.
    await user.click(canvas.getByRole("button", { name: "Search projects" }));
    const input = canvas.getByRole("textbox", { name: "Search projects" });
    await user.type(input, "zzz");
    await waitFor(() => expect(canvas.getByText("No projects match “zzz”.", { exact: false })).toBeInTheDocument());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(rowByName(canvasElement, "Engram on small models")).toBeTruthy());

    // Archived scope: the archived project leaves the active list and shows here.
    await user.click(canvas.getByRole("tab", { name: "Archived" }));
    await waitFor(() => expect(rowByName(canvasElement, "Tokenizer sweep")).toBeTruthy());
    expect(rowByName(canvasElement, "Tokenizer sweep")!.textContent).toContain("No work yet");
    expect(rowByName(canvasElement, "Engram on small models")).toBeFalsy();
    expect(canvas.queryByText("4 tasks · 1 done")).toBeNull();
  },
};

/** No archived projects anywhere: the archived scope says so instead of an empty list. */
export const EmptyArchivedScope: Story = {
  name: "Project index · nothing archived",
  parameters: {
    ...wide,
    router: { routes: [{ path: "/work", element: <WorkBoard projects={allProjects.filter((p) => !p.archived)} tasks={fixtureTasks} runs={fixtureRuns} /> }], initialEntries: ["/work"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await user.click(canvas.getByRole("tab", { name: "Archived" }));
    await waitFor(() => expect(canvas.getByText(/Nothing archived\. Archived projects keep their history and leave the sidebar\./)).toBeInTheDocument());
  },
};

// ---- one project's board ----

/** ?project=engram: four columns at 1 each, the proposal dashed, and History one click away and back. */
export const ProjectBoardColumns: Story = {
  name: "Project board · columns and history tab",
  parameters: {
    ...wide,
    router: { routes: [boardRoutes.routes[0]], initialEntries: ["/work?project=engram"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // The breadcrumb names the project; the four heads carry one card each.
    expect(canvas.getByRole("link", { name: "Work" })).toBeInTheDocument();
    expect(canvas.getByRole("heading", { name: "Engram on small models" })).toBeInTheDocument();
    const headRow = canvasElement.querySelector("div.sticky")!;
    expect(headRow.textContent).toBe("Proposed1In progress1In review1Done1");

    // The proposal card is dashed and names its would-be lead; the done card carries its report link.
    const proposed = [...canvasElement.querySelectorAll("article")].find((a) => a.className.includes("border-dashed"))!;
    expect(proposed.textContent).toContain("Can these results drive a real product?");
    expect(proposed.textContent).toContain("Proposed by Dana · Diego would lead");
    const done = [...canvasElement.querySelectorAll("article")].find((a) => a.textContent!.includes("n-gram fusion on a 135M model"))!;
    expect(within(done).getByRole("link", { name: "Report" })).toBeInTheDocument();

    // The finished loops invite you to History — the real tab, through the segmented control.
    await user.click(canvas.getByRole("button", { name: "2 finished loops in History" }));
    await waitFor(() => expect(canvas.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(canvas.getByText("Previous loops")).toBeInTheDocument());
    expect(canvasElement.querySelectorAll("li > a").length).toBe(2);

    // …and back to the board with the same control.
    await user.click(canvas.getByRole("tab", { name: "Board" }));
    await waitFor(() => expect(canvasElement.querySelector("div.sticky")).not.toBeNull());
  },
};

/** An archived project's board: reachable from the archived index, empty, history intact. */
export const ArchivedProjectBoard: Story = {
  name: "Archived project · empty board",
  parameters: {
    ...wide,
    router: { routes: [boardRoutes.routes[0]], initialEntries: ["/work?scope=archived"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(rowByName(canvasElement, "Tokenizer sweep")!);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Tokenizer sweep" })).toBeInTheDocument());
    expect(canvas.getByText(/No work in this project yet\. Ask Dana in one of its threads, and her proposal lands here\./)).toBeInTheDocument();
    expect(storyRouter()!.state.location.search).toContain("project=tokenizer");

    // Back to the index the same way a user would: the breadcrumb (active scope, so the
    // archived project yields to the live ones).
    await user.click(canvas.getByRole("link", { name: "Work" }));
    await waitFor(() => expect(rowByName(canvasElement, "Engram on small models")).toBeTruthy());
  },
};

// ---- teams lens ----

/** The team's own workflow as columns; the member strip reads live states; switching teams swaps the world. */
export const TeamsLensSteps: Story = {
  name: "Teams lens · steps, members, team switch",
  parameters: {
    ...wide,
    router: { routes: [boardRoutes.routes[0]], initialEntries: ["/work?view=teams"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Research Team: no proposal pending, so no Proposed column — the six steps plus Done.
    const section = (label: string) => canvasElement.querySelector(`section[aria-label="${label}"]`);
    for (const label of ["Plan", "Prepare", "Synthesize", "Implement", "Validate", "Review", "Done"]) expect(section(label)).not.toBeNull();
    expect(section("Proposed")).toBeFalsy();
    expect(section("Implement")!.textContent).toContain("1");
    expect(section("Review")!.textContent).toContain("1");
    expect(section("Done")!.textContent).toContain("1");

    // The Now strip: the two waits read "Needs you", Sana is blocked on Jonah's shard.
    const memberRow = (name: string) => [...canvasElement.querySelectorAll("li")].find((li) => li.textContent?.includes(name))!;
    expect(memberRow("Elliot").textContent).toContain("Needs you");
    expect(memberRow("Jonah").textContent).toContain("Needs you");
    expect(memberRow("Sana").textContent).toContain("Blocked");
    expect(memberRow("Megan").textContent).toContain("Idle");

    // One click on the real segmented control: the Product Team's world, proposal included.
    await user.click(canvas.getByRole("tab", { name: "Product Team" }));
    await waitFor(() => expect(section("Proposed")).not.toBeNull());
    expect(section("Proposed")!.textContent).toContain("Can these results drive a real product?");
    expect(section("Frame")).not.toBeNull();
    expect(canvasElement.textContent).toContain("Led by Diego");
    expect(canvasElement.textContent).toContain("1 task, 0 loops");

    // The empty team steps stay narrow but present; the card counter says zero.
    expect(section("Prototype")!.textContent).toContain("0");
  },
};
