// Browser-card stories (ANY-14 M3): the browser errand status line, the personal-context
// recall line, and the browser submission confirmation — mounted in the composed
// production thread (provider stack + scripted mock adapter, no live agent, no real
// browser task, no API/SSE — the guard hard-fails any attempt).
//
// State → story inventory. The runtime derives a tool-call part's status from its
// assistant message's status (toMessagePartStatus ignores a part-level status field for
// tool-calls), so the status stories set ThreadMessageLike.status — the same field a
// live run and session.ts's imported history produce:
//   Browser errand   running    "working in Session panel"   → BrowserTaskRunning
//                    incomplete "stopped" (error maps here)  → BrowserTaskIncomplete
//                    complete   "finished"                   → BrowserTaskComplete
//   Personal context running    "recalling"                  → RecallRunning
//                    incomplete "unavailable"               → RecallIncomplete
//                    complete   "recalled"                   → RecallComplete
//   Excluded, deliberately: "pending" — neither status card has a pending bucket; a
//   browser_task/recall part carries no args or result, so mid-stream it simply renders
//   its running copy. requires-action is not reachable as a distinct state for these
//   tools in production: it is only produced for human-tool parts (confirm_browser via
//   unstable_humanToolNames) or by the message repository's pending fallback for a
//   result-less part in idle history, which both cards fold into their finished bucket.
//   Confirmation      streaming args (no confirmation yet)   → ConfirmationPreparing
//                     awaiting decision → approved (play)    → ConfirmationApproved
//                     awaiting decision → declined (play)    → ConfirmationDeclined
//                     decided approved (static result)       → ConfirmationApprovedState
//                     decided declined (static result)       → ConfirmationDeclined
//   Excluded: a "disabled while a run is in flight" story — isRunning is only true
//   while a run is in flight, which the plays themselves cross (the decision starts the
//   scripted run); it cannot be direct-loaded.
//
// The confirmation plays assert the full contract: the click lands exactly that decision
// on the tool-call part (the card flips to its decided copy, controls gone), the
// scripted adapter — the stand-in backend — continues the thread, and networkAttempts()
// stays empty.

import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { networkAttempts } from "../../../.storybook/guard";
import { ChatScreen } from "./chat-fixtures";

const meta = {
  title: "Chat/Browser cards",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level: the status lines and the decided note are
      // muted-foreground text below the 4.5:1 bar — the same design tokens
      // cards.stories.tsx scopes out. Fixing means changing the design tokens, outside
      // this card's file scope. Every other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// ---- thread fixtures --------------------------------------------------------

type ThreadParts = Extract<ThreadMessageLike["content"], readonly unknown[]>;
type ToolCallPart = Extract<ThreadParts[number], { type: "tool-call" }>;
type ContentPart = ThreadParts[number];

/** A tool-call part as the runtime holds it (same shape session.ts's toRuntimePart emits). */
function toolCall(toolCallId: string, toolName: string, args?: unknown, result?: unknown): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    ...(args === undefined ? {} : { args: args as Record<string, never> }),
    ...(result === undefined ? {} : { result }),
  };
}

function assistantMsg(status: MessageStatus | undefined, ...parts: ContentPart[]): ThreadMessageLike {
  return { role: "assistant", ...(status ? { status } : {}), content: parts };
}

const decision = (d: "approved" | "declined") => ({ decision: d });

// The statuses a tool-call part can actually carry (ToolCallMessagePartStatus ⊂ message
// status): live-streaming, ended-with-error/cancel, and settled. Fictional venue, no
// contact details — the card deliberately omits args/results that could carry them.
const RUNNING: MessageStatus = { type: "running" };
const COMPLETE: MessageStatus = { type: "complete", reason: "stop" };
const ERRORED: MessageStatus = { type: "incomplete", reason: "error" };
const CANCELLED: MessageStatus = { type: "incomplete", reason: "cancelled" };

const STATUS_THREAD = (toolName: "browser_task" | "recall", status: MessageStatus): ThreadMessageLike[] => [
  assistantMsg(status, toolCall(`${toolName}-1`, toolName)),
];

const CONFIRMATION_ARGS = {
  runId: "run-browser-1",
  summary: "Book a table for two at Tsukimi on Friday at 19:00 — confirm before anything is submitted.",
  confirmation: { date: "Fri, Oct 16", time: "19:00", partySize: 2, reference: "TSK-4412" },
};

const CONFIRM_PENDING_THREAD: ThreadMessageLike[] = [
  assistantMsg(undefined, toolCall("confirm-1", "confirm_browser", CONFIRMATION_ARGS)),
];

const CONFIRM_PREPARING_THREAD: ThreadMessageLike[] = [
  assistantMsg(undefined, toolCall("confirm-1", "confirm_browser")),
];

const CONFIRM_DECIDED_THREAD = (result: ReturnType<typeof decision>): ThreadMessageLike[] => [
  assistantMsg(undefined, toolCall("confirm-1", "confirm_browser", CONFIRMATION_ARGS, result)),
];

/** The composed thread with a canned history — same mount as the production home route. */
function CardThread({ messages }: { messages: readonly ThreadMessageLike[] }) {
  return <ChatScreen initialMessages={messages} />;
}

const threadRoutes = (messages: readonly ThreadMessageLike[]) => ({
  router: { routes: [{ path: "/", element: <CardThread messages={messages} /> }] },
});

// ---- shared assertions ------------------------------------------------------

/** The status line shows exactly its production copy for the rendered state. */
function assertStatusLine(canvas: ReturnType<typeof within>, line: string) {
  expect(canvas.getByText(line)).toBeInTheDocument();
  expect(canvas.getByRole("status")).toHaveTextContent(line);
}

/** After a decision the card states it and the controls are gone. */
async function assertDecided(canvas: ReturnType<typeof within>, note: RegExp) {
  await waitFor(() => expect(canvas.getByText(note)).toBeInTheDocument());
  expect(canvas.queryByRole("button", { name: "Approve submission" })).toBeNull();
  expect(canvas.queryByRole("button", { name: "Decline" })).toBeNull();
}

/** The confirmation card's awaiting state: summary, typed details, both controls enabled. */
function assertAwaiting(canvas: ReturnType<typeof within>) {
  expect(canvas.getByText("Confirm reservation submission")).toBeInTheDocument();
  expect(canvas.getByText(CONFIRMATION_ARGS.summary)).toBeInTheDocument();
  expect(canvas.getByText("Fri, Oct 16")).toBeInTheDocument();
  expect(canvas.getByText("19:00")).toBeInTheDocument();
  expect(canvas.getByText("2")).toBeInTheDocument();
  expect(canvas.getByText("TSK-4412")).toBeInTheDocument();
  expect(canvas.getByRole("button", { name: "Approve submission" })).toBeEnabled();
  expect(canvas.getByRole("button", { name: "Decline" })).toBeEnabled();
}

// ---- browser errand (tool: browser_task) ----

/** Live errand: the status line points at the Session panel. */
export const BrowserTaskRunning: Story = {
  name: "Browser errand · running",
  parameters: threadRoutes(STATUS_THREAD("browser_task", RUNNING)),
  play: async ({ canvasElement }) => {
    assertStatusLine(within(canvasElement), "Browser errand · working in Session panel");
  },
};

/** The errand died (error/cancel): the line says so, not "finished". */
export const BrowserTaskIncomplete: Story = {
  name: "Browser errand · stopped",
  parameters: threadRoutes(STATUS_THREAD("browser_task", ERRORED)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    assertStatusLine(canvas, "Browser errand · stopped");
    expect(canvas.getByRole("status")).not.toHaveTextContent("finished");
  },
};

/** The errand settled: the line reports finished. */
export const BrowserTaskComplete: Story = {
  name: "Browser errand · finished",
  parameters: threadRoutes(STATUS_THREAD("browser_task", COMPLETE)),
  play: async ({ canvasElement }) => {
    assertStatusLine(within(canvasElement), "Browser errand · finished");
  },
};

// ---- personal context (tool: recall) ----

/** Live recall: the memory lookup is in flight. */
export const RecallRunning: Story = {
  name: "Personal context · recalling",
  parameters: threadRoutes(STATUS_THREAD("recall", RUNNING)),
  play: async ({ canvasElement }) => {
    assertStatusLine(within(canvasElement), "Personal context · recalling");
  },
};

/** The recall could not complete: the line says unavailable, not "recalled". */
export const RecallIncomplete: Story = {
  name: "Personal context · unavailable",
  parameters: threadRoutes(STATUS_THREAD("recall", CANCELLED)),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    assertStatusLine(canvas, "Personal context · unavailable");
    expect(canvas.getByRole("status")).not.toHaveTextContent("recalled");
  },
};

/** The recall landed: the line reports recalled. */
export const RecallComplete: Story = {
  name: "Personal context · recalled",
  parameters: threadRoutes(STATUS_THREAD("recall", COMPLETE)),
  play: async ({ canvasElement }) => {
    assertStatusLine(within(canvasElement), "Personal context · recalled");
  },
};

// ---- confirmation (human tool: confirm_browser) ----

/** Args still streaming: the card is a placeholder — no controls to decide with yet. */
export const ConfirmationPreparing: Story = {
  name: "Confirmation · preparing",
  parameters: threadRoutes(CONFIRM_PREPARING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Preparing reservation confirmation…")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Approve submission" })).toBeNull();
    expect(canvas.queryByRole("button", { name: "Decline" })).toBeNull();
  },
};

/** Awaiting → approved: the click lands exactly {decision: "approved"} on the part (the
 * card flips to its approved copy, controls gone), the scripted adapter continues the
 * thread, and nothing touched the network — no real browser task, no HTTP. */
export const ConfirmationApproved: Story = {
  name: "Confirmation · pending → approved",
  parameters: threadRoutes(CONFIRM_PENDING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    assertAwaiting(canvas);
    await user.click(canvas.getByRole("button", { name: "Approve submission" }));
    await assertDecided(canvas, /Approved — Dana can submit this reservation\./);

    // The scripted adapter — the stand-in backend — saw the turn and answers in-thread.
    await waitFor(() => expect(canvas.getByText(/Mock reply/)).toBeInTheDocument(), { timeout: 5000 });
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** Awaiting → declined: the click lands exactly {decision: "declined"} on the part. */
export const ConfirmationDeclined: Story = {
  name: "Confirmation · pending → declined",
  parameters: threadRoutes(CONFIRM_PENDING_THREAD),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    assertAwaiting(canvas);
    await user.click(canvas.getByRole("button", { name: "Decline" }));
    await assertDecided(canvas, /Declined — this reservation will not be submitted\./);
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** Approved (arrived via history): the approved copy, no controls, details intact. */
export const ConfirmationApprovedState: Story = {
  name: "Confirmation · approved",
  parameters: threadRoutes(CONFIRM_DECIDED_THREAD(decision("approved"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Approved — Dana can submit this reservation.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Approve submission" })).toBeNull();
    expect(canvas.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(canvas.getByText("TSK-4412")).toBeInTheDocument();
  },
};

/** Declined (arrived via history): the declined copy, no controls. */
export const ConfirmationDeclinedState: Story = {
  name: "Confirmation · declined",
  parameters: threadRoutes(CONFIRM_DECIDED_THREAD(decision("declined"))),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Declined — this reservation will not be submitted.")).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Approve submission" })).toBeNull();
    expect(canvas.queryByRole("button", { name: "Decline" })).toBeNull();
  },
};
