// Chat screen stories (ANY-12 M3): the composed production thread — routes/home.tsx's
// mounting of AssistantThread, provider stack included, driven by the scripted mock
// adapter (no live agent, no API/SSE — the guard hard-fails any attempt).
//
// State → story inventory:
//   Empty / new thread (hero, greeting, suggestions, composer + bar)  → NewThread
//   Existing thread (canned history, chip top bar, session panel)     → ExistingThread
//   Streaming reply (working portrait, text grows, send gated)        → StreamingReply
//   Run error (adapter failure → MessagePrimitive.Error)              → RunError
//   Incognito (veiled hero, off-the-record copy, explainer panel)     → IncognitoThread
//   Determinism + mock-only networking                                → ScreenDirectLoad,
//                                                                       ScreenAfterAnotherChat
// ScreenDirectLoad and ScreenAfterAnotherChat assert the same fixture-derived content:
// the latter is reached only after another chat story ran (and after an in-story round
// trip through another route), proving stories render identically however they load.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { dana } from "@fabric/fixtures/assistant";
import { suggestionPool } from "@fabric/fixtures/suggestions";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { networkAttempts } from "../../../.storybook/guard";
import type { ChatModelRunResult } from "@assistant-ui/react";
import { ChatScreen, EXISTING_THREAD, failNextAssistantRun } from "./chat-fixtures";
import { mockAssistant } from "@/lib/mock/chat";

const meta = {
  title: "Chat/Thread",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level: the chat pairs muted-foreground / foreground-opacity
      // text (the 10px context-meter readouts, inactive tab triggers, small pill labels)
      // below the 4.5:1 bar — the same design tokens studio-ui.stories.tsx scopes out.
      // Fixing means changing the design tokens, outside this card's file scope. Every
      // other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const SUGGESTION_LABELS = new Set(suggestionPool.map((s) => s.label));

/** Everything the fresh empty screen must show, read off the rendered DOM. Retried because
 * the thread's empty→started flicker at mount briefly renders both the hero and the chip. */
async function assertFreshScreen(canvasElement: HTMLElement) {
  await waitFor(() => {
    const canvas = within(canvasElement);
    // Hero: Dana's portrait and pill, her greeting heading.
    expect(canvas.getByRole("img", { name: dana.name })).toBeInTheDocument();
    expect(canvas.getByText(dana.name)).toBeInTheDocument();
    expect(canvas.getByRole("heading", { name: dana.greeting })).toBeInTheDocument();
    expect(canvas.getByText("Agent 1 of 4")).toBeInTheDocument();

    // Composer idle: her placeholder, the voice entry, no Send yet; the tray's pickers.
    const input = canvas.getByRole("textbox");
    expect(input).toHaveAttribute("placeholder", dana.placeholder);
    expect(canvas.getByRole("button", { name: "Voice conversation" })).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Send" })).toBeNull();
    expect(canvas.getByRole("button", { name: "Choose project" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Add connector" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Run on: This machine" })).toBeInTheDocument();

    // Context meter in the tray: base tokens only, no messages yet.
    expect(canvas.getByRole("meter", { name: "Context usage" })).toHaveAttribute("aria-valuenow", "2140");

    // Suggestions: the current page of the rotating pool — three fixture prompts.
    const suggestions = canvas
      .getAllByRole("button")
      .filter((b) => SUGGESTION_LABELS.has(b.textContent ?? ""));
    expect(suggestions).toHaveLength(3);
  }, { timeout: 3000 });
}

/** The empty / new-thread screen, loaded directly. */
export const NewThread: Story = {
  name: "New thread",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);
  },
};

/** Same screen, same content, reached after another chat story — stories are hermetic. */
export const ScreenAfterAnotherChat: Story = {
  name: "Screen · after another chat story",
  parameters: {
    router: {
      routes: [
        { path: "/", element: <ChatScreen /> },
        { path: "/agents", element: <p data-testid="elsewhere">Elsewhere</p> },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);

    // Round-trip through another route and back: the screen renders identically.
    const router = storyRouter();
    if (!router) throw new Error("chat screen play: no active story router");
    await router.navigate("/agents?agent=jonah");
    await waitFor(() => expect(within(canvasElement).getByTestId("elsewhere")).toBeInTheDocument());
    await router.navigate("/");
    await waitFor(() => expect(within(canvasElement).queryByTestId("elsewhere")).toBeNull());
    await assertFreshScreen(canvasElement);
  },
};

/** The mock-only guard: a full visit to the composed screen makes zero network attempts. */
export const ScreenDirectLoad: Story = {
  name: "Screen · direct load, no network",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** A thread with history: both messages render, the hero flies up into the top bar. */
export const ExistingThread: Story = {
  name: "Existing thread",
  parameters: {
    router: { routes: [{ path: "*", element: <ChatScreen initialMessages={EXISTING_THREAD} /> }] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Both canned messages render as bubbles.
    expect(canvas.getByText("Set up a baseline eval harness for the 135M model.")).toBeInTheDocument();
    expect(canvas.getByText("On it — I'll draft the harness, wire the held-out split, and run the baseline tonight.")).toBeInTheDocument();

    // The hero has flown up into the top bar: chip portrait, no Agents/Teams switcher.
    expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument();
    expect(canvas.queryByRole("tab", { name: "Agents" })).toBeNull();

    // The context meter moved into the composer toolbar: 2,140 base + 2 × 1,800.
    expect(canvas.getAllByRole("meter", { name: "Context usage" })).toHaveLength(1);
    expect(canvas.getByRole("meter", { name: "Context usage" })).toHaveAttribute("aria-valuenow", "5740");

    // The session side panel: desktop placeholder plus the tray's settings rows.
    await user.click(canvas.getByRole("button", { name: "Open side panel" }));
    const panel = canvas.getByRole("complementary", { name: "Dana's profile" });
    expect(within(panel).getByText("No desktop session")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Choose project" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Run on: This machine" })).toBeInTheDocument();
    // A second meter appears in the session panel — same thread, same accounting.
    const meters = canvas.getAllByRole("meter", { name: "Context usage" });
    expect(meters).toHaveLength(2);
    for (const meter of meters) expect(meter).toHaveAttribute("aria-valuenow", "5740");

    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};

/** Streaming: the portrait flips to its working loop, the reply arrives word by word. */
export const StreamingReply: Story = {
  name: "Streaming reply",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const input = canvas.getByRole("textbox");

    await user.type(input, "What's an n-gram, in one line?");

    // The scripted stream runs ~700 ms end to end, and the mid-run send gate is only
    // observable while the run is in flight — waiting for the full reply first (as this
    // story used to) raced the run's completion on slower runners (CI red on 7faeda6).
    // Hold the mock run open for a beat after its stream ends so the gated-send window
    // below is deterministic; the trailing hold elapses before the re-enable asserts.
    // Restored in finally so no later story inherits the slow adapter.
    const original = mockAssistant.run;
    type RunConfig = Parameters<typeof mockAssistant.run>[0];
    mockAssistant.run = (async function* (config: RunConfig) {
      yield* original(config) as AsyncGenerator<ChatModelRunResult, void, unknown>;
      await new Promise((r) => setTimeout(r, 1500));
    }) as unknown as typeof mockAssistant.run;

    try {
      await user.click(canvas.getByRole("button", { name: "Send" }));

      // The run starts: Dana's portrait switches to its working loop.
      await waitFor(() => expect(canvas.getByRole("img", { name: "Dana, working" })).toBeInTheDocument());

      // The reply streams: partial text visible while the run is still going.
      await waitFor(
        () => expect(canvasElement.textContent).toContain("An n-gram is a run of n consecutive tokens."),
        { timeout: 5000, interval: 20 },
      );

      // A follow-up typed mid-run shows the composer's gated send…
      await user.type(input, " And the held-out split?");
      expect(canvas.getByRole("button", { name: "Send" })).toBeDisabled();

      // …which re-enables when the run completes, and the whole reply is on screen.
      await waitFor(
        () => expect(canvas.getByRole("button", { name: "Send" })).toBeEnabled(),
        { timeout: 5000 },
      );
      await waitFor(
        () => expect(canvasElement.textContent).toContain("lookup-table language model."),
        { timeout: 5000 },
      );
      await waitFor(() => expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument());
    } finally {
      mockAssistant.run = original;
    }
  },
};

/** Run failure: the adapter throws, the message shows the error box. */
export const RunError: Story = {
  name: "Run error",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const restore = failNextAssistantRun("Storybook: simulated assistant failure");
    try {
      const user = userEvent.setup();
      await user.type(canvas.getByRole("textbox"), "Say something.");
      await user.click(canvas.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(canvas.getByRole("alert")).toBeInTheDocument());
      expect(canvas.getByRole("alert")).toHaveTextContent("Storybook: simulated assistant failure");
      // No assistant reply arrived — only the error display.
      expect(canvasElement.textContent).not.toContain("Mock reply");
    } finally {
      restore();
    }
  },
};

/** Incognito: veiled hero pinned to Dana, off-the-record copy, explainer panel with a way out. */
export const IncognitoThread: Story = {
  name: "Incognito thread",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("switch", { name: "Incognito chat" }));

    // The hero is veiled and pinned to Dana: no chevrons, the switcher disabled.
    await waitFor(() => {
      expect(canvas.getByRole("img", { name: "Dana" })).toHaveClass("grayscale");
      expect(canvas.getByText("Dana · incognito")).toBeInTheDocument();
      expect(canvas.queryByRole("button", { name: "Next agent" })).toBeNull();
      expect(canvas.getByRole("tab", { name: "Agents" })).toBeDisabled();
    });

    // Off-the-record copy replaces the greeting.
    expect(canvas.getByRole("heading", { name: "Incognito chat" })).toBeInTheDocument();
    expect(canvas.getByText("Not saved to your sessions or used to shape your assistant.")).toBeInTheDocument();
    expect(canvas.getByRole("textbox")).toHaveAttribute("placeholder", "Tell Dana anything, off the record…");

    // The profile opens on the incognito explainer, with a way out.
    await user.click(canvas.getByRole("button", { name: "Toggle Dana · incognito's profile" }));
    const panel = canvas.getByRole("complementary", { name: "Dana's profile" });
    expect(within(panel).getByRole("tab", { name: "Incognito" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByText("Not saved")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Turn off incognito" })).toBeInTheDocument();

    // Turning it off keeps the panel open but hands the card back to Dana's own profile.
    await user.click(within(panel).getByRole("button", { name: "Turn off incognito" }));
    await waitFor(() => {
      expect(within(panel).getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
      expect(within(panel).getByRole("heading", { name: "Dana" })).toBeInTheDocument();
    });
    expect(canvas.getByRole("heading", { name: "What's on your plate, Ty?" })).toBeInTheDocument();

    // …and the panel closes from its own affordance.
    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};

// ---- Session era (ANY-62 S12b): the W cases. Each thread runs on the session
// protocol (post, then follow); the closing leg of each story re-enters the
// thread and demands the exchange from the session, which the pre-session
// mock path (no store, no markSent) cannot satisfy — that leg is the red
// assertion. The reply texts are the scripted mock's own, so the assertions
// hold under whichever backend serves the turn.

const W_QUESTION = "What is the capital of France?";
const W_REPLY_HEAD = "I can answer that direct"; // proper prefix: mid-reply state
const W_REPLY_TAIL = "placeholder.)"; // only in the complete reply
const W_ROUTES = (sessionId: string) => [
  // Keyed by session: a route swap between two threads must remount the screen
  // (the production HomePage keys the thread by sessionId too), never update
  // the mounted instance in place with the previous thread's runtime content.
  { path: "/", element: <ChatScreen key={sessionId} sessionId={sessionId} /> },
  { path: "/away", element: <p data-testid="away">Away</p> },
];

/** Leave the thread and come back through the story router (fresh mount, same session). */
async function roundTrip() {
  const router = storyRouter();
  if (!router) throw new Error("W stories: no active story router");
  await router.navigate("/away");
  await waitFor(() => expect(within(document.body).getByTestId("away")).toBeInTheDocument());
  await router.navigate("/");
}

/** W1 — the turn streams: provisional grows into the final reply, the composer
 * re-enables, and the finished exchange survives leaving and reopening. */
export const W1SessionTurn: Story = {
  name: "W1 session turn streams, settles and persists",
  parameters: { router: { routes: W_ROUTES("w1-thread") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.type(canvas.getByRole("textbox"), W_QUESTION);
    await user.click(canvas.getByRole("button", { name: "Send" }));

    // Provisional text first, the complete reply later: the turn streams.
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_HEAD), { timeout: 5000, interval: 50 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_TAIL), { timeout: 5000, interval: 50 });

    // The turn ended: the composer takes the next message (it empties on send,
    // so the gated Send only exists once a follow-up is typed).
    await user.type(canvas.getByRole("textbox"), "And Rome?");
    await waitFor(() => expect(canvas.getByRole("button", { name: "Send" })).toBeEnabled(), { timeout: 5000 });

    // The exchange lives in the session: a fresh mount of the same thread shows it.
    await roundTrip();
    const reopened = within(canvasElement);
    await waitFor(() => expect(reopened.getByRole("textbox")).toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_QUESTION), { timeout: 5000, interval: 50 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_TAIL), { timeout: 5000, interval: 50 });
  },
};

/** W2 — a thread reopened mid-turn shows the provisional text, then the final reply. */
export const W2ReopenMidTurn: Story = {
  name: "W2 thread reopened mid-turn shows provisional then final",
  parameters: { router: { routes: W_ROUTES("w2-thread") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.type(canvas.getByRole("textbox"), W_QUESTION);
    await user.click(canvas.getByRole("button", { name: "Send" }));

    // Leave while the reply is still streaming.
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_HEAD), { timeout: 5000, interval: 50 });
    await roundTrip();

    // The reopened thread shows the turn: provisional text, then the final reply.
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_HEAD), { timeout: 5000, interval: 50 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_TAIL), { timeout: 5000, interval: 50 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_QUESTION), { timeout: 5000, interval: 50 });
  },
};

/** W3 — a specialist thread answers as the specialist; an incognito thread keeps
 * its Not-saved notice after the turn, and both persist across a reopen. */
export const W3SpecialistAndIncognito: Story = {
  name: "W3 specialist reply and incognito notice on session threads",
  parameters: {
    router: {
      routes: [
        ...W_ROUTES("w3-specialist"),
        { path: "/incognito", element: <ChatScreen key="w3-incognito" sessionId="w3-incognito" /> },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Specialist leg: wait for the roster, switch off Dana, ask, get Jonah's reply.
    await waitFor(() => expect(canvas.getByText("Agent 1 of 4")).toBeInTheDocument(), { timeout: 5000 });
    await user.click(canvas.getByRole("button", { name: "Next agent" }));
    await waitFor(() => expect(canvas.getByText("Agent 2 of 4")).toBeInTheDocument(), { timeout: 5000 });
    await user.type(canvas.getByRole("textbox"), W_QUESTION);
    await user.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(canvasElement.textContent).toContain("Jonah here."), { timeout: 5000, interval: 50 });
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_TAIL), { timeout: 5000, interval: 50 });

    // The specialist exchange survives a reopen too.
    await roundTrip();
    await waitFor(() => expect(canvasElement.textContent).toContain("Jonah here."), { timeout: 5000, interval: 50 });

    // Incognito leg: a fresh thread, off the record; the notice stands after the turn.
    const router = storyRouter();
    if (!router) throw new Error("W3: no active story router");
    await router.navigate("/incognito");
    const incognito = within(canvasElement);
    await waitFor(() => expect(incognito.getByRole("switch", { name: "Incognito chat" })).toBeInTheDocument(), { timeout: 5000 });
    await user.click(incognito.getByRole("switch", { name: "Incognito chat" }));
    // The remount races the click: retry until the switch reads on.
    await waitFor(async () => {
      const switchEl = incognito.getByRole("switch", { name: "Incognito chat" });
      if (switchEl.getAttribute("aria-checked") !== "true") await user.click(switchEl);
      expect(switchEl).toHaveAttribute("aria-checked", "true");
    }, { timeout: 5000 });
    await waitFor(() => expect(incognito.getByText("Not saved to your sessions or used to shape your assistant.")).toBeVisible(), { timeout: 5000 });
    await user.type(incognito.getByRole("textbox"), W_QUESTION);
    await user.click(incognito.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(canvasElement.textContent).toContain(W_REPLY_TAIL), { timeout: 5000, interval: 50 });
    await user.click(incognito.getByRole("button", { name: "Toggle Dana · incognito's profile" }));
    const panel = incognito.getByRole("complementary", { name: "Dana's profile" });
    expect(within(panel).getByText("Not saved")).toBeInTheDocument();
  },
};
