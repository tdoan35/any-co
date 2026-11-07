// Week grid stories (ANY-22 M7): the state matrix and overlap layout, component-level with
// every pin as a prop — `todayKey` pinned, occurrences hand-stamped to the shape
// `mockOccurrences` emits (the page-level stories cover the loader path).
//
// State → story inventory:
//   all nine occurrence states + the two-column overlap
//                            → EveryStateOverlapping (play: each state's title/word, the
//                              struck-through skipped/missed, the running ring, the dashed
//                              upcoming, and the overlap's 50% split)
//   empty grid               → EmptyGrid (day heads, no blocks, now-line on the pinned day)
//
// The now-line's position is the wall clock by design; its presence here is pinned via
// `todayKey`. Clock-text is asserted by shape, never literal — times render in the viewer's
// zone on purpose.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { WeekGrid } from "./week-grid";
import { fromKey, weekStart } from "@/lib/schedule";
import type { Occurrence } from "@fabric/contracts";

const meta = {
  title: "Schedule/Week grid",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level: the muted hour gutter and day-head metas sit below
      // 4.5:1 — the same tokens every prior card scoped. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const WEEK_START = weekStart(fromKey("2026-10-04"));
const TODAY = "2026-10-06";

const at = (day: string, h: number, m: number) => new Date(`2026-10-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-07:00`).toISOString();
const span = (day: string, h: number, m: number, dur: number) => {
  const end = h * 60 + m + dur;
  return { at: at(day, h, m), end: at(day, Math.floor(end / 60) % 24, end % 60) };
};
const occ = (day: string, h: number, m: number, dur: number, over: Partial<Occurrence> & { state: Occurrence["state"]; title: string }): Occurrence => ({
  scheduleId: "morning-digest", agentId: "dana", kind: "assistant", ...span(day, h, m, dur), ...over,
});

const EVERY_STATE: Occurrence[] = [
  occ("05", 9, 0, 60, { scheduleId: "weekly-literature-sweep", agentId: "elliot", title: "Weekly literature sweep", kind: "team", state: "accepted", runId: "run-ngram-1", taskId: "ngram-135m" }),
  occ("05", 11, 0, 30, { title: "Morning digest", state: "posted", messageId: "msg-404" }),
  occ("06", 9, 0, 30, { title: "Morning digest", state: "upcoming" }),
  occ("06", 9, 0, 60, { scheduleId: "weekly-literature-sweep", agentId: "elliot", title: "Weekly literature sweep", kind: "team", state: "running" }),
  occ("07", 8, 0, 30, { scheduleId: "demand-pulse", agentId: "diego", title: "Demand pulse", kind: "team", state: "blocked", runId: "run-nand-2", taskId: "nand-probe" }),
  occ("07", 13, 0, 30, { title: "Morning digest", state: "stopped" }),
  occ("08", 9, 0, 30, { title: "Morning digest", state: "skipped" }),
  occ("08", 14, 0, 45, { scheduleId: "demand-pulse", agentId: "diego", title: "Demand pulse", kind: "team", state: "missed" }),
  occ("09", 8, 0, 30, { title: "Morning digest", state: "failed" }),
];

/** All nine states at once, with the Tuesday overlap splitting into two columns. */
export const EveryStateOverlapping: Story = {
  name: "Every state · overlapping columns",
  render: () => (
    <div className="flex h-[600px] flex-col">
      <WeekGrid
        from={WEEK_START}
        occurrences={EVERY_STATE}
        todayKey={TODAY}
        onSelect={() => {}}
        onPickSlot={() => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // One block per state, the word in the tooltip, the tint on the border.
    const upcoming = canvas.getByTitle(/^Morning digest · Upcoming ·/);
    expect(upcoming).toHaveClass("border-dashed");
    const running = canvas.getByTitle(/^Weekly literature sweep · Running ·/);
    expect(running).toHaveClass("ring-1");
    canvas.getByTitle(/^Weekly literature sweep · Accepted ·/);
    canvas.getByTitle(/^Morning digest · Posted ·/);
    canvas.getByTitle(/^Demand pulse · Blocked ·/);
    canvas.getByTitle(/^Morning digest · Stopped ·/);
    expect(canvas.getByTitle(/^Morning digest · Skipped ·/)).toHaveClass("line-through");
    expect(canvas.getByTitle(/^Demand pulse · Missed ·/)).toHaveClass("line-through");
    expect(canvas.getByTitle(/^Morning digest · Failed ·/)).toHaveClass("border-destructive/60");
    expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5);

    // The Tuesday pair overlaps → side-by-side halves; Monday's two don't.
    expect(upcoming.getAttribute("style")).toContain("left: calc(0% + 2px)");
    expect(running.getAttribute("style")).toContain("left: calc(50% + 2px)");
    expect(canvas.getByTitle(/^Morning digest · Posted ·/).getAttribute("style")).toContain("left: calc(0% + 2px)");

    // The now-line lives on the pinned today column.
    expect(canvasElement.querySelector('[aria-label="Now"]')).not.toBeNull();
  },
};

/** A week with nothing scheduled: heads and gutters only. */
export const EmptyGrid: Story = {
  name: "Empty grid",
  render: () => (
    <div className="flex h-[600px] flex-col">
      <WeekGrid from={WEEK_START} occurrences={[]} todayKey={TODAY} onSelect={() => {}} onPickSlot={() => {}} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Sun")).toBeInTheDocument();
    expect(canvas.getByText("Sat")).toBeInTheDocument();
    expect(canvas.getByText("6")).toBeInTheDocument(); // the pinned today's head number
    expect(canvas.queryAllByTitle(/·/)).toHaveLength(0);
    expect(canvasElement.querySelector('[aria-label="Now"]')).not.toBeNull();
  },
};
