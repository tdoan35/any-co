// Transport stories (ANY-20 M6): play, scrub, speed and the verdict-halting fast-forward,
// driven through the production useRunClock — no clock is left running; everything ends
// parked or paused so assertions are exact.
//
// State → story inventory:
//   end, paused    → EndParksPaused (the finished loop's parked clock; restart via Play)
//   end, paused    → MarkerScrubsToVerdict (the marker buttons are the deterministic scrub)
//   playing 600×   → FastForwardHaltsOnVerdict (typed mini fixture: stops at 1m40s and 2m40s,
//                     so 600× lands between ticks — halts asserted, then played home)
//   speed          → SpeedButtonsTogglePressed (aria-pressed is the state)
//   now, live      → GoLiveReturnsToNow (scrub away, Go live returns; the button disabled
//                     state tracks `at now`)
//   sim live-start → covered at screen level (Work/Task screen · Live start) where the
//                     badge and the URL live
//
// The mini fixture is a typed Run/RunEvent pair with two verdict stops 60 loop-seconds
// apart — fast enough that 600× playback resolves inside one test tick.

import { useMemo } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runs as fixtures, runEventsById } from "@fabric/fixtures/work";
import type { Run, RunEvent } from "@fabric/contracts";
import { runMarkers } from "@/lib/run-state";
import { useRunClock, type ClockStart } from "@/lib/use-run-clock";
import { Transport } from "./transport";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Transport",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior file: muted time text on the
      // translucent bar sits below the 4.5:1 bar. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const m = (min: number) => min * 60;

/** The mini timing fixture: a three-minute loop whose verdicts stop 60 loop-seconds apart. */
const miniRun: Run = {
  id: "run-mini-halt",
  taskId: "mini-halt",
  teamId: "research",
  n: 1,
  objective: "Timing fixture: two verdict stops a minute apart.",
  status: "accepted",
  startedAt: "2026-10-02T09:00:00-07:00",
  recorded: false,
  durationS: m(3),
  costUsd: 0.01,
  budget: { costUsd: 1, timeS: m(3) },
  reworkBudget: 2,
  assistantTokens: 100,
  brief: { tokens: 10, objective: "Stop twice on the way to the end.", constraints: [], criteria: [], preferences: [], stayed: [] },
  segments: [],
};
const miniEvent = (seq: number, t: number, type: RunEvent["type"], payload: RunEvent["payload"] = {}): RunEvent => ({
  runId: miniRun.id, seq, t, type, payload,
});
const miniEvents: RunEvent[] = [
  miniEvent(1, 0, "run.started"),
  miniEvent(2, m(1) + 40, "review.verdict", { verdict: "request_changes", text: "Stop one." }),
  miniEvent(3, m(1) + 40, "rework.requested", { to: "elliot", used: 1, budget: 2 }),
  miniEvent(4, m(2) + 40, "review.verdict", { verdict: "accept", text: "Stop two." }),
];

/** Mounts Transport over the real hook, with stops derived from the log as LoopScreen does. */
function TransportStage({ run, events, start }: { run: Run; events: RunEvent[]; start: ClockStart }) {
  const markers = useMemo(() => runMarkers(events), [events]);
  const stops = useMemo(() => markers.filter((mk) => mk.kind === "bounce" || mk.kind === "accept").map((mk) => mk.t), [markers]);
  const clock = useRunClock(run.durationS, start, stops);
  return <Transport clock={clock} max={clock.max} markers={markers} start={start} />;
}

const transport = (run: Run, events: RunEvent[], start: ClockStart) => ({
  render: () => <TransportStage run={run} events={events} start={start} />,
});

const run135 = fixtures[0];
const events135 = runEventsById[run135.id];
const run360 = fixtures.find((r) => r.id === "run-ngram360-1")!;
const events360 = runEventsById[run360.id];

/** A finished loop parks paused at its end; Play restarts it from zero, Pause pins it again. */
export const EndParksPaused: Story = {
  name: "End · parked paused; play restarts, pause pins",
  ...transport(run135, events135, "end"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("3h 12m / 3h 12m")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Play" })).toBeInTheDocument();

    // Play at the end restarts from zero; the time reads small again.
    await user.click(canvas.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(canvas.getByText(/^[0-9]+s \/ 3h 12m$/)).toBeInTheDocument());

    // Pausing freezes the clock exactly: a beat later, the same reading.
    await user.click(canvas.getByRole("button", { name: "Pause" }));
    const frozen = canvas.getByText(/\/ 3h 12m/).textContent;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(canvas.getByText(/\/ 3h 12m/).textContent).toBe(frozen);
  },
};

/** The markers are scrubs: landing on one puts the playhead exactly on its second. */
export const MarkerScrubsToVerdict: Story = {
  name: "Marker · scrubs exactly onto the verdict",
  ...transport(run135, events135, "end"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Changes requested at 2h 35m" }));
    const input = canvas.getByLabelText("Scrub the loop") as HTMLInputElement;
    expect(input.value).toBe("9300");
    expect(input.getAttribute("aria-valuetext")).toBe("2h 35m");
    expect(canvas.getByText("2h 35m / 3h 12m")).toBeInTheDocument();
  },
};

/** 600× from the end halts on the first verdict, then the next, then the final second. */
export const FastForwardHaltsOnVerdict: Story = {
  name: "Fast-forward · halts on each verdict, then ends",
  ...transport(miniRun, miniEvents, "end"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("button", { name: "Fast-forward" }));
    await waitFor(() => expect(canvas.getByText("1m 40s / 3m 00s")).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: "Play" })).toBeInTheDocument();

    // Resuming keeps the 600× and halts on the accept.
    await user.click(canvas.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(canvas.getByText("2m 40s / 3m 00s")).toBeInTheDocument());

    // The last resume runs out the clock: no stop remains, the end parks paused.
    await user.click(canvas.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(canvas.getByText("3m 00s / 3m 00s")).toBeInTheDocument());
    await waitFor(() => expect(canvas.getByRole("button", { name: "Play" })).toBeInTheDocument());
  },
};

/** The speed group is a pressed-state toggle, not a hidden setting. */
export const SpeedButtonsTogglePressed: Story = {
  name: "Speed · pressed state moves with the click",
  ...transport(run135, events135, "end"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByRole("button", { name: "60×" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(canvas.getByRole("button", { name: "600×" }));
    expect(canvas.getByRole("button", { name: "600×" }).getAttribute("aria-pressed")).toBe("true");
    expect(canvas.getByRole("button", { name: "60×" }).getAttribute("aria-pressed")).toBe("false");
  },
};

/** Scrub away from now and Go live returns; the button's disabled state tracks at-now. */
export const GoLiveReturnsToNow: Story = {
  name: "Live · scrub back, Go live returns to now",
  ...transport(run360, events360, "now"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("2h 15m / 2h 15m")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Go live" })).toBeDisabled();

    await user.click(canvas.getByRole("button", { name: "Blocked network.fetch at 2h 03m" }));
    expect(canvas.getByText("2h 03m / 2h 15m")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Go live" })).toBeEnabled();

    await user.click(canvas.getByRole("button", { name: "Go live" }));
    await waitFor(() => expect(canvas.getByText("2h 15m / 2h 15m")).toBeInTheDocument());
    expect(canvas.getByRole("button", { name: "Go live" })).toBeDisabled();
  },
};
