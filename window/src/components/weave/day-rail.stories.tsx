// Day rail stories: the "what's my day?" column — the mini calendar's pick flow and
// the timebox for today, a future day, a past day and an empty day. (The presence
// strip that used to open this column moved to the top of Weave's inbox; its stories
// live in presence-strip.stories.tsx.)
//
// State → story inventory (all calendar kinds; none excluded):
//   calendar meeting c1/c4, focus c3/c5/c6/c9, personal c2
//                                          → Timebox · today (past events dimmed on
//                                             Past day) — every kind appears
//   markers   deadline (Hackathon demo) · activity (runs)
//                                          → chips + mini-calendar dots asserted
//   day pick  2026-10-04 (events + "today" deadline) → Day pick and timebox (play)
//   past day  2026-09-29                              → Past day · dimmed events
//   empty day 2026-10-06                              → Empty day
//
// Documented exclusions:
//   - No wall-clock dependence: the harness pins the mock clock to WEAVE_NOW
//     (2026-10-02 11:20 PT), so the now-line, "in N days" chips and event dimming are
//     identical every run.
//   - The now-line div in day-rail.tsx carries role="img" (added in ANY-15),
//     so no rule is disabled for it here.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TODAY } from "./format";
import { DayRail } from "./day-rail";

const meta = {
  title: "Weave/Day rail",
  decorators: [WithHarness],
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
 * Stands the rail up with `day` in a controlled state. `picked` records onPickDay
 * calls so the day-pick seam is assertable.
 */
function DayRailPane({ initialDay = TODAY }: { initialDay?: string }) {
  const [day, setDay] = useState(initialDay);
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="w-[300px] border-r border-foreground/10 bg-background/40">
      <DayRail day={day} onPickDay={(d) => { setDay(d); setPicked((p) => [...p, `day:${d}`]); }} />
      <div data-testid="picked">{picked.join(" ")}</div>
    </div>
  );
}

// ---- day picking and the timebox ----

/** Today's timebox, the now-line, deadline chips, and a pick that re-renders the day. */
export const DayPickAndTimebox: Story = {
  name: "Day pick · future day and back",
  render: () => <DayRailPane />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Today: four events across meeting/focus/personal, and the now-line at the
    // pinned 11:20 AM clock.
    expect(canvas.getByText("Your day")).toBeInTheDocument();
    expect(canvas.getByText("Neon gateway spike review")).toBeInTheDocument();
    expect(canvas.getByText("Lunch")).toBeInTheDocument();
    expect(canvas.getByText("Focus: demo rehearsal")).toBeInTheDocument();
    expect(canvas.getByText("Sponsor check-in")).toBeInTheDocument();
    expect(canvas.getByLabelText("Now, 11:20 AM")).toBeInTheDocument();
    expect(canvas.getByText("Hackathon demo in 2 days")).toBeInTheDocument();

    // The mini calendar marks the deadline and the selected day.
    const selected = canvas.getByRole("button", { name: "Friday, October 2 · 360M run in progress" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("button", { name: "Sunday, October 4 · Hackathon demo" })).toBeInTheDocument();

    // Picking the hackathon day switches the timebox: its events, the deadline now
    // "today", and no now-line on a day that isn't today.
    await user.click(canvas.getByRole("button", { name: "Sunday, October 4 · Hackathon demo" }));
    await waitFor(() => expect(canvas.getByText("Sunday, Oct 4")).toBeInTheDocument());
    expect(canvas.getByText("Hackathon setup")).toBeInTheDocument();
    expect(canvas.getByText("Hacking")).toBeInTheDocument();
    expect(canvas.getByText("Hackathon demo · today")).toBeInTheDocument();
    expect(canvas.queryByLabelText(/^Now,/)).toBeNull();
    expect(canvasElement.querySelector("[data-testid='picked']")!.textContent).toContain("day:2026-10-04");

    // Back to today restores the default heading through the same seam.
    await user.click(canvas.getByRole("button", { name: "Back to today" }));
    await waitFor(() => expect(canvas.getByText("Your day")).toBeInTheDocument());
    expect(canvasElement.querySelector("[data-testid='picked']")!.textContent).toContain("day:2026-10-02");
  },
};

/** A past day: its events dim (they're over), the deadline is still ahead. */
export const PastDayDimmed: Story = {
  name: "Past day · dimmed events",
  render: () => <DayRailPane initialDay="2026-09-29" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Tuesday, Sep 29")).toBeInTheDocument();
    // A 30-minute event is below the height where the time label renders, so the
    // window is read from the event's title (title: "Review the 135M results · 4:30 PM–5:00 PM").
    const event = canvas.getByText("Review the 135M results").closest(".opacity-50");
    expect(event).not.toBeNull();
    expect(event!.getAttribute("title")).toContain("4:30 PM–5:00 PM");
    expect(canvas.getByText("Hackathon demo in 5 days")).toBeInTheDocument();
    expect(canvas.queryByLabelText(/^Now,/)).toBeNull();
    expect(canvas.getByRole("button", { name: "Back to today" })).toBeInTheDocument();
  },
};

/** A day with nothing on it: the empty line instead of events. */
export const EmptyDay: Story = {
  name: "Empty day",
  render: () => <DayRailPane initialDay="2026-10-06" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Tuesday, Oct 6")).toBeInTheDocument();
    expect(canvas.getByText("Nothing on your calendar.")).toBeInTheDocument();
    expect(canvas.queryByLabelText(/^Now,/)).toBeNull();
    expect(canvas.queryByRole("button", { name: "Back to today" })).not.toBeNull();
  },
};
