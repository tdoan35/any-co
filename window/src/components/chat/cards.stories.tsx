// Tool-card stories (ANY-13 M3): the cards Dana posts mid-conversation — dispositions,
// team/specialist proposals, the handoff and the results message — mounted in the
// composed production thread (provider stack + scripted mock adapter, no live agent,
// no API/SSE — the guard hard-fails any attempt).
//
// State → story inventory:
//   Team proposal       pending → approved (play)                      → TeamProposalApproved
//                       approved (static result)                       → TeamProposalApprovedState
//                       declined (static result)                       → TeamProposalDeclined
//                       discussing (static result)                     → TeamProposalDiscussing
//                       superseded (play: revision link scrolls)       → TeamProposalSuperseded
//   Specialist proposal pending → approved (play)                      → SpecialistProposalApproved
//                       approved (static result)                       → SpecialistProposalApprovedState
//                       declined (static result)                       → SpecialistProposalDeclined
//                       discussing (static result)                     → SpecialistProposalDiscussing
//                       superseded (play: revision link scrolls)       → SpecialistProposalSuperseded
//   Handoff             starting (args only, no loop yet)              → HandoffStarting
//                       running (payload; play: View loop navigates)   → HandoffRunning
//   Results             posted loop results (play: Open report)        → Results
//   Disposition         delegating chip rendered / handle_directly not → DispositionChip
//
// The pending → approved plays assert the full contract: the decision lands on the
// tool-call part (badge + note update, controls gone), the scripted adapter — the
// stand-in backend — sees the {decision} and answers in-thread, and networkAttempts()
// stays empty.

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { handoff, specialistProposal, teamProposal } from "@fabric/fixtures/chat";
import { report } from "@fabric/fixtures/run";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { networkAttempts } from "../../../.storybook/guard";
import { ChatScreen } from "./chat-fixtures";

const meta = {
  title: "Chat/Tool cards",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level: the chat pairs muted-foreground / foreground-opacity
      // text below the 4.5:1 bar — the same design tokens chat-screen.stories.tsx scopes
      // out. Fixing means changing the design tokens, outside this card's file scope.
      // Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// ---- thread fixtures -------------------------------------------------------
// Typed data from @fabric/fixtures — the same payloads the mock adapter and the
// demo seed stream — so the cards render with realistic content, not lorem ipsum.

type ThreadParts = Extract<ThreadMessageLike["content"], readonly unknown[]>;
type ToolCallPart = Extract<ThreadParts[number], { type: "tool-call" }>;
type ContentPart = ThreadParts[number];

/** A tool-call part as the runtime holds it (same shape session.ts's toRuntimePart emits). */
function toolCall(toolCallId: string, toolName: string, args: unknown, result?: unknown): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: args as Record<string, never>,
    argsText: JSON.stringify(args),
    ...(result === undefined ? {} : { result }),
  };
}

const text = (t: string) => ({ type: "text" as const, text: t });

function assistant(...parts: ContentPart[]): ThreadMessageLike {
  return { role: "assistant", content: parts };
}

const decision = (d: "approved" | "declined" | "discuss") => ({ decision: d });

const user = (t: string): ThreadMessageLike => ({ role: "user", content: t });

/** The composed thread with a canned history — same mount as the production home route. */
function CardThread({ messages }: { messages: readonly ThreadMessageLike[] }) {
  return <ChatScreen initialMessages={messages} />;
}

const ROUTES = {
  // Stub views beyond the thread, so a card's Link click can be asserted end to end.
  work: { path: "/work/:taskId", element: <p data-testid="loop-view">Loop view</p> },
  reports: { path: "/reports/:reportId", element: <p data-testid="report-view">Report view</p> },
} as const;

const threadRoutes = (messages: readonly ThreadMessageLike[], ...extra: readonly { path: string; element: React.ReactElement }[]) => ({
  router: { routes: [{ path: "/", element: <CardThread messages={messages} /> }, ...extra] },
});

const TEAM_PENDING_THREAD: ThreadMessageLike[] = [
  user("I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model."),
  assistant(
    toolCall("team-proposal-1", "propose_team", teamProposal),
  ),
];

const TEAM_DECIDED_THREAD = (result: ReturnType<typeof decision>) => [
  assistant(toolCall("team-proposal-1", "propose_team", teamProposal, result)),
];

const TEAM_SUPERSEDED_THREAD: ThreadMessageLike[] = [
  assistant(
    toolCall("team-orig", "propose_team", teamProposal, decision("discuss")),
    toolCall("team-rev", "propose_team", { ...teamProposal, supersedes: "team-orig" }),
  ),
];

const SPECIALIST_PENDING_THREAD: ThreadMessageLike[] = [
  assistant(toolCall("specialist-proposal-1", "propose_specialist", specialistProposal)),
];

const SPECIALIST_DECIDED_THREAD = (result: ReturnType<typeof decision>) => [
  assistant(toolCall("specialist-proposal-1", "propose_specialist", specialistProposal, result)),
];

const SPECIALIST_SUPERSEDED_THREAD: ThreadMessageLike[] = [
  assistant(
    toolCall("spec-orig", "propose_specialist", specialistProposal, decision("discuss")),
    toolCall("spec-rev", "propose_specialist", { ...specialistProposal, supersedes: "spec-orig" }),
  ),
];

const HANDOFF_STARTING_THREAD: ThreadMessageLike[] = [
  assistant(
    text("On it — handing the experiment to the team now."),
    toolCall("handoff-1", "handoff_to_team", { teamName: "Research Team" }),
  ),
];

const HANDOFF_RUNNING_THREAD: ThreadMessageLike[] = [
  assistant(
    text("On it — handing the experiment to the team now."),
    toolCall("handoff-1", "handoff_to_team", handoff),
  ),
];

const RESULTS_THREAD: ThreadMessageLike[] = [
  assistant(
    toolCall("results-1", "post_results", {
      reportId: report.id,
      runId: report.runId,
      taskId: "ngram-135m",
      title: report.title,
      summary: report.summary,
      rows: report.results,
    }),
  ),
];

const DISPOSITION_THREAD: ThreadMessageLike[] = [
  user("What's an n-gram, in one line?"),
  assistant(
    toolCall("disp-1", "record_disposition", { disposition: "handle_directly", reason: "Conceptual question; no delegation needed." }, { recorded: true }),
    text("An n-gram is a run of n consecutive tokens."),
  ),
  assistant(
    toolCall("disp-2", "record_disposition", { disposition: "propose_team", reason: "Multi-step research: survey, implement, review. Best handled by a team." }, { recorded: true }),
    text("That's an interesting idea — but I think it would go better if I built a research team for it."),
  ),
];

// ---- shared assertions -----------------------------------------------------

/** After a decision the controls are gone and the badge says so — for the given word. */
async function assertDecided(canvas: ReturnType<typeof within>, badge: RegExp) {
  await waitFor(() => expect(canvas.getByText(badge)).toBeInTheDocument());
  for (const name of ["Build team", "No", "Chat about this", "Yes, create Sana"]) {
    expect(canvas.queryByRole("button", { name })).toBeNull();
  }
}

/** The superseded card is collapsed to one line pointing at its revision; the revision card
 * itself is pending, so exactly one of its decision controls remains (the revision's). */
function assertSupersededLine(canvas: ReturnType<typeof within>, revisionAction: RegExp) {
  expect(canvas.getByText(/replaced by a revised proposal/)).toBeInTheDocument();
  expect(canvas.getByRole("button", { name: /See revision/ })).toBeInTheDocument();
  expect(canvas.getAllByRole("button", { name: revisionAction })).toHaveLength(1);
}

/** Clicking "See revision" scrolls the revision card into view. */
async function assertRevisionRevealed(canvas: ReturnType<typeof within>, revisionDomId: string) {
  await userEvent.setup().click(canvas.getByRole("button", { name: /See revision/ }));
  const revision = document.getElementById(revisionDomId);
  expect(revision).not.toBeNull();
  await waitFor(() => {
    const rect = revision!.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  });
}

// ---- team proposal (CARD-1) ----

/** Pending: badge, typed roster/workflow/criteria, and the decision flow — approved emits
 * {decision} to the scripted adapter, which answers with the next proposal, mock-only. */
export const TeamProposalApproved: Story = {
  name: "Team proposal · pending → approved",
  parameters: threadRoutes(TEAM_PENDING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("Needs approval")).toBeInTheDocument();
    expect(canvas.getByText("Research Team")).toBeInTheDocument();
    expect(canvas.getByText("Elliot")).toBeInTheDocument();
    expect(canvas.getByText(/Research Lead/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Build team" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "No" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Chat about this" })).toBeEnabled();

    await user.click(canvas.getByRole("button", { name: "Build team" }));
    await assertDecided(canvas, /^Approved$/);

    // The scripted adapter saw the {decision} and proposed the missing capability in-thread.
    await waitFor(() => expect(canvas.getByText("New specialist")).toBeInTheDocument(), { timeout: 5000 });
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** Approved (arrived via history): badge, no controls, no note. */
export const TeamProposalApprovedState: Story = {
  name: "Team proposal · approved",
  parameters: threadRoutes(TEAM_DECIDED_THREAD(decision("approved"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/^Approved$/)).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Build team" })).toBeNull();
    expect(canvas.queryByText(/Nothing was created/)).toBeNull();
  },
};

/** Declined (CARD-6): the card stays visible and says nothing was created. */
export const TeamProposalDeclined: Story = {
  name: "Team proposal · declined",
  parameters: threadRoutes(TEAM_DECIDED_THREAD(decision("declined"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Declined")).toBeInTheDocument();
    expect(canvas.getByText("Declined. Nothing was created.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Build team" })).toBeNull();
  },
};

/** Discussing: nothing created until a proposal is approved. */
export const TeamProposalDiscussing: Story = {
  name: "Team proposal · discussing",
  parameters: threadRoutes(TEAM_DECIDED_THREAD(decision("discuss"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Discussing")).toBeInTheDocument();
    expect(canvas.getByText("Discussing — nothing is created until you approve a proposal.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Build team" })).toBeNull();
  },
};

/** Superseded (CARD-4): collapsed to one line; "See revision" scrolls to the revision. */
export const TeamProposalSuperseded: Story = {
  name: "Team proposal · superseded",
  parameters: threadRoutes(TEAM_SUPERSEDED_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    assertSupersededLine(canvas, /^Build team$/);
    // The revision itself is a live pending proposal.
    expect(canvas.getByText("Needs approval")).toBeInTheDocument();
    await assertRevisionRevealed(canvas, "card-team-rev");
  },
};

// ---- specialist proposal (D1, CARD-3) ----

/** Pending: the pool persona is pinned (nothing renames after approval); approving emits
 * {decision} to the scripted adapter, which hands off to the team, mock-only. */
export const SpecialistProposalApproved: Story = {
  name: "Specialist proposal · pending → approved",
  parameters: threadRoutes(SPECIALIST_PENDING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("New specialist")).toBeInTheDocument();
    expect(canvas.getByText("Sana")).toBeInTheDocument();
    expect(canvas.getByText(/Validator/)).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Yes, create Sana" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "No" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "Chat about this" })).toBeEnabled();

    await user.click(canvas.getByRole("button", { name: "Yes, create Sana" }));
    await assertDecided(canvas, /^Approved$/);

    // The scripted adapter saw the {decision} and handed off in-thread.
    await waitFor(() => expect(canvas.getByText(/Task handed off to Research Team/)).toBeInTheDocument(), { timeout: 5000 });
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** Approved (arrived via history): badge, no controls. */
export const SpecialistProposalApprovedState: Story = {
  name: "Specialist proposal · approved",
  parameters: threadRoutes(SPECIALIST_DECIDED_THREAD(decision("approved"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/^Approved$/)).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Yes, create Sana" })).toBeNull();
  },
};

/** Declined: the card stays visible and says nothing was created. */
export const SpecialistProposalDeclined: Story = {
  name: "Specialist proposal · declined",
  parameters: threadRoutes(SPECIALIST_DECIDED_THREAD(decision("declined"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Declined")).toBeInTheDocument();
    expect(canvas.getByText("Declined. Nothing was created.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Yes, create Sana" })).toBeNull();
  },
};

/** Discussing: nothing created until a proposal is approved. */
export const SpecialistProposalDiscussing: Story = {
  name: "Specialist proposal · discussing",
  parameters: threadRoutes(SPECIALIST_DECIDED_THREAD(decision("discuss"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Discussing")).toBeInTheDocument();
    expect(canvas.getByText("Discussing — nothing is created until you approve a proposal.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Yes, create Sana" })).toBeNull();
  },
};

/** Superseded (CARD-4): collapsed to one line; "See revision" scrolls to the revision. */
export const SpecialistProposalSuperseded: Story = {
  name: "Specialist proposal · superseded",
  parameters: threadRoutes(SPECIALIST_SUPERSEDED_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    assertSupersededLine(canvas, /^Yes, create Sana$/);
    expect(canvas.getByText("New specialist")).toBeInTheDocument();
    await assertRevisionRevealed(canvas, "card-spec-rev");
  },
};

// ---- handoff ----

/** Streaming: Dana's args only — the card says it's handing off, with no loop to link yet. */
export const HandoffStarting: Story = {
  name: "Handoff · starting",
  parameters: threadRoutes(HANDOFF_STARTING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/Handing off to Research Team/)).toBeInTheDocument();
    expect(canvas.getByText("Starting")).toBeInTheDocument();
    expect(canvas.getByText("Compiling the brief and starting the run.")).toBeInTheDocument();
    expect(canvas.queryByRole("link", { name: /View loop/ })).toBeNull();
  },
};

/** Payload landed: typed members with states, and the loop link navigates in the story router. */
export const HandoffRunning: Story = {
  name: "Handoff · running",
  parameters: threadRoutes(HANDOFF_RUNNING_THREAD, ROUTES.work),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText(/Task handed off to Research Team/)).toBeInTheDocument();
    expect(canvas.getByText("Running")).toBeInTheDocument();
    expect(canvas.getByText("Elliot")).toBeInTheDocument();
    expect(canvas.getByText("Research Lead")).toBeInTheDocument();
    expect(canvas.getByText("planning")).toBeInTheDocument();
    expect(canvas.getByText("Sana")).toBeInTheDocument();
    expect(canvas.getByText("preparing checks")).toBeInTheDocument();
    expect(canvas.getByRole("link", { name: /View loop/ })).toHaveAttribute("href", "/work/ngram-135m?live=1");

    await user.click(canvas.getByRole("link", { name: /View loop/ }));
    await waitFor(() => expect(canvas.getByTestId("loop-view")).toBeInTheDocument());
    expect(storyRouter()?.state.location.pathname).toBe("/work/ngram-135m");
  },
};

// ---- results (CHAT-14) ----

/** Dana's results message: valid rows only, in a table, with the report and loop links. */
export const Results: Story = {
  name: "Results",
  parameters: threadRoutes(RESULTS_THREAD, ROUTES.reports),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("Results")).toBeInTheDocument();
    expect(canvas.getByText(report.title)).toBeInTheDocument();
    expect(canvas.getByText("Baseline · 135M model")).toBeInTheDocument();
    expect(canvas.getByText("34.2")).toBeInTheDocument();
    expect(canvas.getByText("Fused · attempt 2 (held-out split)")).toBeInTheDocument();
    expect(canvas.getByText("30.9")).toBeInTheDocument();
    expect(canvas.getByText("−9.6%")).toBeInTheDocument();
    // The reworked attempt 1 was invalid: never shown on the card.
    expect(canvas.queryByText("Fused · attempt 1")).toBeNull();
    expect(canvas.getByRole("link", { name: /Open report/ })).toHaveAttribute("href", "/reports/report-ngram-1");
    expect(canvas.getByRole("link", { name: "View loop" })).toHaveAttribute("href", "/work/ngram-135m");

    await user.click(canvas.getByRole("link", { name: /Open report/ }));
    await waitFor(() => expect(canvas.getByTestId("report-view")).toBeInTheDocument());
    expect(storyRouter()?.state.location.pathname).toBe("/reports/report-ngram-1");
  },
};

// ---- disposition (CHAT-13) ----

/** The chip renders for a delegating disposition (reason on hover) and not for handle_directly. */
export const DispositionChipStory: Story = {
  name: "Disposition chip",
  parameters: threadRoutes(DISPOSITION_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("propose team")).toBeInTheDocument();
    expect(canvas.getByTitle("Multi-step research: survey, implement, review. Best handled by a team.")).toBeInTheDocument();
    expect(canvas.queryByText("handle directly")).toBeNull();
  },
};
