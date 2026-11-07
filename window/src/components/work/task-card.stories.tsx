// Task card stories (ANY-19 M6): one story per real card state — Dana's proposal waiting
// for your yes, a running loop with waits and asks, the blocked review at zero rework, the
// accepted loop with its report, and the team-lens corner. The card is computed through the
// production `summarize` against the seeded stores, exactly as the board would hand it over.
//
// State → story inventory:
//   proposed            → ProposedWaitingForYes (play: ask flag → Weave, card → task)
//   in_progress + waits → RunningWaitingOnYou (play: overlay opens the task)
//   in_review, blocked  → BlockedAtReview (zero budget left, escalation flag)
//   done, accepted      → DoneWithReport (play: report link → /reports/…)
//   lens="team" corner  → TeamLensNamesProject
//   caveat / stopped    → covered by the State pill states story in Work/Parts (pill level);
//                         no seeded task ends in those without a Weave decision, and
//                         decisions are screen-level (Work/Screen), not card-level
//   "Preview" chip      → on the proposed card (no Product Team loop recorded)
//
// The summary comes from `summarize(task, runs, weave)` — fixture tasks/runs, store weave —
// so the card shows what the real board shows for the same seed.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runs as fixtureRuns, tasks as fixtureTasks } from "@fabric/fixtures/work";
import { projects } from "@fabric/fixtures/sessions";
import { useWeave } from "@/lib/weave-store";
import { summarize } from "@/lib/work";
import type { Task } from "@fabric/contracts";
import { TaskCard } from "./task-card";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Task card",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: the blocked label and muted
      // metas sit below the 4.5:1 bar on translucent panels — the same design tokens the
      // Weave/chat/studio cards scoped out. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="card-location">{`Location: ${pathname}${search}`}</p>;
}

/** Computes the card's summary from the seeded stores, then renders it above a location probe. */
function CardOf({ id, lens, project }: { id: string; lens: "project" | "team"; project?: string }) {
  const weave = useWeave();
  const task = fixtureTasks.find((t) => t.id === id) as Task;
  const summary = summarize(task, fixtureRuns, weave);
  return (
    <div className="w-80">
      <TaskCard s={summary} lens={lens} project={projects.find((p) => p.id === project)} />
      <LocationProbe />
    </div>
  );
}

const cardRoutes = (id: string, lens: "project" | "team", project?: string) => ({
  routes: [{ path: "*", element: <CardOf id={id} lens={lens} project={project} /> }],
});

const article = (root: HTMLElement) => root.querySelector("article")!;
const probe = (root: HTMLElement) => root.querySelector("[data-testid=card-location]")?.textContent;

// ---- proposed ----

/** Dana's proposal: dashed card, the bet's purpose, and the ask flag jumps to Weave while the card opens the task. */
export const ProposedWaitingForYes: Story = {
  name: "Proposed · waiting for your yes",
  parameters: { router: cardRoutes("product-bet", "project") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const card = article(canvasElement);

    expect(card.className).toContain("border-dashed");
    expect(card.querySelector("h3")!.textContent).toBe("Can these results drive a real product?");
    expect(card.textContent).toContain("Diego frames the bet, Lila looks for demand, and Maya sketches a first experience.");
    expect(card.textContent).toContain("Proposed by Dana · Diego would lead");
    expect(canvas.getByText("Preview")).toBeInTheDocument();
    const flag = canvas.getByRole("button", { name: /Waiting for your yes/ });
    expect(flag.className).toContain("bg-warn-soft");

    // The flag is above the card link: it jumps to the proposal in Weave…
    await user.click(flag);
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /weave?item=handoff-product"));

    // …and the card itself opens the task (the inset overlay is the card's link).
    await user.click(canvas.getByRole("link", { name: "Open Can these results drive a real product?" }));
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /work/product-bet"));
  },
};

// ---- in progress, waiting on you ----

/** The running loop: stage dots, the two waits ringed amber, both asks counted, ETA pinned by the mock clock. */
export const RunningWaitingOnYou: Story = {
  name: "Running · waits, asks and ETA",
  parameters: { router: cardRoutes("ngram-360m", "project") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const card = article(canvasElement);

    expect(canvas.getByText("Running")).toBeInTheDocument();
    expect(card.textContent).toContain("Implement");
    expect(card.querySelector("[aria-label^='Plan:']")!.getAttribute("aria-label")).toContain("Implement: waiting on you");
    expect(card.textContent).toContain("ETA 2:40 PM");

    // Two agents wait on you (Elliot's seeds, Jonah's shard), ringed warn.
    const warnFaces = card.querySelectorAll(".ring-warn\\/70");
    expect(warnFaces.length).toBe(2);
    expect(warnFaces[0].getAttribute("title")).toContain("Elliot ·");

    // Both open asks, counted in words.
    expect(canvas.getByRole("button", { name: "2 asks waiting on you" })).toBeInTheDocument();

    // The whole card is the link.
    await user.click(canvas.getByRole("link", { name: "Open n-gram fusion at 360M" }));
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /work/ngram-360m"));
  },
};

// --- in review, out of budget ---

/** Loop 2 at the review gate with the budget spent: blocked pill, amber stage label, the escalation flag. */
export const BlockedAtReview: Story = {
  name: "Blocked · review gate, budget spent",
  parameters: { router: cardRoutes("nand-probe", "project") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = article(canvasElement);

    expect(canvas.getByText("Blocked")).toBeInTheDocument();
    expect(canvas.getByText("Loop 2")).toBeInTheDocument();
    const stage = [...card.querySelectorAll("span")].find((s) => s.textContent === "Review" && s.className.includes("text-warn"))!;
    expect(stage).toBeDefined();
    expect(card.textContent).toContain("rework 2/2");
    expect(canvas.getByRole("button", { name: "Escalated to you" })).toBeInTheDocument();
  },
};

// ---- done ----

/** The accepted loop keeps its report one click away, and the card opens the task's history. */
export const DoneWithReport: Story = {
  name: "Done · accepted with report link",
  parameters: { router: cardRoutes("ngram-135m", "project") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const card = article(canvasElement);

    expect(canvas.getByText("Accepted")).toBeInTheDocument();
    const report = within(card).getByRole("link", { name: "Report" });
    expect(report.getAttribute("href")).toBe("/reports/report-ngram-1");
    expect(canvas.getByRole("button", { name: "1 ask waiting on you" })).toBeInTheDocument();

    await user.click(report);
    await waitFor(() => expect(probe(canvasElement)).toBe("Location: /reports/report-ngram-1"));
  },
};

// ---- team lens ----

/** On a team board the corner names the project instead of the team. */
export const TeamLensNamesProject: Story = {
  name: "Team lens · corner names the project",
  parameters: { router: cardRoutes("nand-probe", "team", "engram") },
  play: async ({ canvasElement }) => {
    const card = article(canvasElement);
    expect(card.textContent).toContain("Engram on small models");
    expect(card.textContent).not.toContain("Research Team");
    expect(card.querySelector("h3")!.textContent).toBe("NAND latency probe");
  },
};
