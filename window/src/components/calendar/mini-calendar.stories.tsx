// Mini calendar stories (ANY-22 M7): the month grid's marks, week highlight, today ring and
// month paging, with `today` pinned so repeated runs are identical (the production default is
// the mock clock's TODAY, also pinned — passed explicitly here regardless).
//
// State → story inventory:
//   activity/deadline marks + week highlight + today ring
//                            → MarkedWeek (play: aria-labels carry the dot labels, deadline
//                              and activity dots tint differently, the selected week tints,
//                              the pinned today rings)
//   month paging             → MonthPaging (next/previous month, selection persists)
//
// A11y: the muted weekday letters and out-of-month days sit below 4.5:1 — the same tokens
// every prior card scoped; every other rule errors.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { MiniCalendar } from "./mini-calendar";
import type { DayMark } from "./mini-calendar";

const meta = {
  title: "Calendar/Mini calendar",
  component: MiniCalendar,
  decorators: [WithHarness],
  parameters: {
    a11y: {
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta<typeof MiniCalendar>;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => {};

/** Schedule-style marks: activity dots on days with routines, a deadline mid-month. */
const MARKS: Record<string, DayMark[]> = {
  "2026-10-02": [{ label: "1 routine", kind: "activity" }],
  "2026-10-09": [{ label: "Proposal due", kind: "deadline" }],
  "2026-10-16": [{ label: "Proposal due", kind: "deadline" }, { label: "2 routines", kind: "activity" }],
};
const marks = (key: string) => MARKS[key] ?? [];

/** The selected week tinted, today ringing, both pins explicit. */
export const MarkedWeek: Story = {
  name: "Marked week · dots, tint, today ring",
  args: { selected: "2026-10-06", onPick: noop, marks, highlightWeek: true, today: "2026-10-13" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Marks surface in the accessible name, one dot per label.
    const activity = canvas.getByRole("button", { name: "Friday, October 2 · 1 routine" });
    expect(activity.querySelector(".bg-muted-foreground\\/60")).not.toBeNull();
    const deadline = canvas.getByRole("button", { name: "Friday, October 9 · Proposal due" });
    expect(deadline.querySelector(".bg-warn")).not.toBeNull();
    const both = canvas.getByRole("button", { name: "Friday, October 16 · Proposal due, 2 routines" });
    expect(both.querySelectorAll("span span")).toHaveLength(2);

    // The selected day inverts; the rest of its week tint; the pinned today rings.
    expect(canvas.getByRole("button", { name: "Tuesday, October 6" })).toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("button", { name: "Wednesday, October 7" })).toHaveClass("bg-foreground/[0.06]");
    expect(canvas.getByRole("button", { name: "Tuesday, October 13" })).toHaveClass("ring-1");
    expect(canvas.getByRole("button", { name: "Tuesday, October 13" })).not.toHaveAttribute("aria-pressed", "true");
  },
};

/** Months page independently of the selection; coming back restores it. */
export const MonthPaging: Story = {
  name: "Month paging",
  args: { selected: "2026-10-06", onPick: noop, today: "2026-10-13" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("October 2026")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Next month" }));
    expect(canvas.getByText("November 2026")).toBeInTheDocument();
    // The selection is a month grid away, nothing else moved.
    expect(canvas.queryByRole("button", { name: /October 6/ })).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Previous month" }));
    expect(canvas.getByText("October 2026")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Tuesday, October 6" })).toHaveAttribute("aria-pressed", "true");
  },
};
