// Schedule screen stories (ANY-22 M7): the real route — SchedulePage + scheduleLoader on
// /schedule — mounted in the harness memory router exactly as router.tsx declares it, inside
// the same pathless errorElement layout, plus the page-level states the route can't pin.
//
// State → story inventory (the schedule screen's principal states):
//   populated week, fired/skipped history, mini-calendar markers, routine rail
//                            → FixtureWeek (play: the loader resolves the seeded week's 6
//                              occurrences — 4 posted + 1 skipped digest, 1 accepted sweep;
//                              the editor dialog opens and closes; an occurrence's sheet opens
//                              with its state pill and closes)
//   dark theme               → FixtureWeekDark (same route, `.dark` tokens)
//   agent filter             → AgentFilter (play: toggling Elliot hides only his block, the
//                              counts stay, toggling back restores it)
//   next / previous week     → WeekNavigation (play: Next → the fully-past Oct 4–10 week
//                              renders no blocks; Previous → the 6 come back via the loader)
//   planned / running states, overlap columns, pinned today
//                            → PinnedWeekStates (component-level: the page fed occurrences
//                              directly, `today` pinned — see the seam note below)
//   empty week               → EmptyWeek (component-level: routines listed, nothing planned)
//
// Determinism. The schedule lib deliberately runs on the viewer's clock and timezone ("a
// schedule page is about when things run for you"), so the stories pin what can be pinned:
//   - the week via `?week=` (labels, grid columns, mini-calendar month);
//   - the data, which is past-week fixture fires — stable for any run after 2026-10-04 PT
//     (past-unfired slots are dropped relative to now, and every planned slot in the pinned
//     weeks is past by then); the route stories' pinned weeks are always in the past, so the
//     today-tint/now-line never appear in them;
//   - `today` on the component-level stories via the one-line seam in schedule-page.tsx.
// Clock-text assertions stay tz-tolerant (state words and counts, never literal times): the
// displayed time follows the viewer's zone by design.
//
// The loader runs against the mock API (no server; the harness guard would block one).

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { RouteError } from "@/routes/error";
import { SchedulePageRoute, scheduleLoader, scheduleShouldRevalidate } from "@/routes/schedule";
import { SchedulePage } from "./schedule-page";
import { schedules as seedSchedules } from "@fabric/fixtures/schedules";
import type { Occurrence } from "@fabric/contracts";

const VIEWPORTS = {
  narrow: { name: "Narrow · schedule", styles: { width: "960px", height: "900px" } },
  wide: { name: "Wide · schedule", styles: { width: "1600px", height: "1000px" } },
} as const;

const meta = {
  title: "Schedule/Schedule screen",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level like every prior card: the muted rail labels, counts
      // and the range subtitle sit below the 4.5:1 bar — the same design tokens the Weave,
      // work and studio cards scoped out. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Pathless errorElement layout, as in router.tsx.
const route = (entry: string, viewport: keyof typeof VIEWPORTS = "wide") => ({
  viewport: { defaultViewport: viewport, viewports: VIEWPORTS },
  router: {
    routes: [
      {
        errorElement: <RouteError />,
        children: [
          {
            path: "schedule",
            element: <SchedulePageRoute />,
            loader: scheduleLoader,
            shouldRevalidate: scheduleShouldRevalidate,
          },
        ],
      },
    ],
    initialEntries: [entry],
  },
});

// ---- populated: the seeded week's fired history, markers and the routine rail ----

/** Direct-loaded schedule on the fixture week (Sun Sep 27 – Sat Oct 3, 2026). */
export const FixtureWeek: Story = {
  name: "Fixture week · fired, skipped and the rail",
  parameters: route("/schedule?week=2026-09-27"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The loader resolved the seeded week: five digest blocks (one skipped) and the sweep.
    await waitFor(() => expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5));
    expect(canvas.getAllByTitle(/^Morning digest · Posted ·/)).toHaveLength(4);
    const skipped = canvas.getByTitle(/^Morning digest · Skipped ·/);
    expect(skipped).toHaveClass("line-through");
    expect(canvas.getByTitle(/^Weekly literature sweep · Accepted ·/)).toBeInTheDocument();
    // No phantom blocks: the past-unfired demand pulse is dropped, exactly as the server.
    expect(canvas.queryByTitle(/^Demand pulse ·/)).toBeNull();

    // The header names the pinned week.
    expect(canvas.getByText("Sep 27 – Oct 3")).toBeInTheDocument();

    // The rail counts the agents' occurrences and lists the three routines. Row queries are
    // rail-scoped: every block embeds the agent portrait, so a bare /Dana/ is ambiguous.
    const rail = () => canvas.getByText("Agents").closest("section")!;
    const dana = within(rail()).getByRole("button", { name: /Dana/ });
    expect(dana).toHaveAttribute("aria-pressed", "true");
    expect(within(dana).getByText("5")).toBeInTheDocument();
    const elliot = within(rail()).getByRole("button", { name: /Elliot/ });
    expect(elliot).toHaveAttribute("aria-pressed", "true");
    expect(within(elliot).getByText("1")).toBeInTheDocument();
    expect(canvas.getByText("Daily at 8:00 AM")).toBeInTheDocument();
    expect(canvas.getByText("Weekly on Mon at 9:00 AM")).toBeInTheDocument();
    expect(canvas.getByText("Weekly on Fri at 2:00 PM")).toBeInTheDocument();

    // Mini-calendar markers on the five days with routines; the quiet day has none.
    expect(canvas.getByRole("button", { name: "Monday, September 28 · 2 routines" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Tuesday, September 29 · 1 routine" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Friday, October 2 · 1 routine" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Saturday, October 3" })).toBeInTheDocument();

    // The editor opens from the header and dismisses.
    await userEvent.click(canvas.getByRole("button", { name: /New schedule/ }));
    const editor = await waitFor(() => {
      const dialog = within(document.body).getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      return dialog;
    });
    expect(within(editor).getByRole("heading", { name: "New routine" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());

    // Clicking a block opens its sheet: title, state pill, and the recurrence line.
    await userEvent.click(canvas.getByTitle(/^Weekly literature sweep · Accepted ·/));
    const sheet = await waitFor(() => {
      const dialog = within(document.body).getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      return dialog;
    });
    expect(within(sheet).getByText("Weekly literature sweep")).toBeInTheDocument();
    expect(within(sheet).getByText("accepted")).toBeInTheDocument();
    expect(within(sheet).getByText("Weekly on Mon at 9:00 AM · America/Los_Angeles")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
  },
};

/** The same fixture week under the dark theme. */
export const FixtureWeekDark: Story = {
  name: "Fixture week · dark",
  globals: { theme: "dark" },
  parameters: route("/schedule?week=2026-09-27"),
  play: async ({ canvasElement }) => {
    expect(document.documentElement).toHaveClass("dark");
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5));
    expect(canvas.getByText("Sep 27 – Oct 3")).toBeInTheDocument();
  },
};

// ---- agent filter ----

/** Toggling an agent hides exactly that agent's blocks; the counts and the rest stay. */
export const AgentFilter: Story = {
  name: "Agent filter · hide and restore Elliot",
  parameters: route("/schedule?week=2026-09-27"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5));
    expect(canvas.getAllByTitle(/Weekly literature sweep ·/)).toHaveLength(1);

    const rail = () => canvas.getByText("Agents").closest("section")!;
    const elliotRow = () => within(rail()).getByRole("button", { name: /Elliot/ });
    await userEvent.click(elliotRow());
    expect(elliotRow()).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(canvas.queryByTitle(/Weekly literature sweep ·/)).toBeNull());
    // Dana's blocks are untouched, and the rail counts are the full week's, not the filter's.
    expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5);
    expect(within(elliotRow()).getByText("1")).toBeInTheDocument();

    await userEvent.click(elliotRow());
    expect(elliotRow()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(canvas.getAllByTitle(/Weekly literature sweep ·/)).toHaveLength(1));
  },
};

// ---- week navigation ----

/** Next/previous week re-runs the loader: an empty past week, then the fixture week back. */
export const WeekNavigation: Story = {
  name: "Week navigation · next and previous",
  parameters: route("/schedule?week=2026-09-27"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5));

    await userEvent.click(canvas.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(canvas.getByText("Oct 4 – 10")).toBeInTheDocument());
    // Oct 4–10 is fully in the past with no fires: the grid is empty, on either side of UTC.
    await waitFor(() => expect(canvas.queryByTitle(/^Morning digest ·/)).toBeNull());
    expect(canvas.queryByTitle(/Weekly literature sweep ·/)).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(canvas.getByText("Sep 27 – Oct 3")).toBeInTheDocument());
    await waitFor(() => expect(canvas.getAllByTitle(/^Morning digest · Posted ·/)).toHaveLength(4));
    expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(5);
  },
};

// ---- component-level: states the route cannot pin ----

// Hand-stamped occurrences for the state matrix. Shape-for-shape what `mockOccurrences`
// emits for these schedules — but with the states assigned by hand, because upcoming/running
// slots expire relative to the real now and no fixed week stays "planned" forever. Times sit
// mid-week and mid-day so every timezone agrees on the day keys.
const at = (day: string, h: number, m = 0) => new Date(`2026-10-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-07:00`).toISOString();
const span = (day: string, h: number, m = 0, dur = 30) => {
  const end = h * 60 + m + dur;
  return { at: at(day, h, m), end: at(day, Math.floor(end / 60) % 24, end % 60) };
};

const PINNED_SCHEDULES = seedSchedules;
const PINNED_WEEK = {
  ...span("06", 9), // Tue Oct 6, overlaps the sweep → two columns
  scheduleId: "morning-digest", agentId: "dana", title: "Morning digest", kind: "assistant", state: "upcoming",
} satisfies Occurrence;
const MIXED_WEEK: Occurrence[] = [
  PINNED_WEEK,
  { ...span("06", 9, 0, 60), scheduleId: "weekly-literature-sweep", agentId: "elliot", title: "Weekly literature sweep", kind: "team", state: "running", runId: "run-ngram-1", taskId: "ngram-135m" },
  { ...span("07", 8), scheduleId: "morning-digest", agentId: "dana", title: "Morning digest", kind: "assistant", state: "posted", messageId: "msg-404" },
  { ...span("08", 9, 0, 60), scheduleId: "weekly-literature-sweep", agentId: "elliot", title: "Weekly literature sweep", kind: "team", state: "accepted", runId: "run-ngram-1", taskId: "ngram-135m", reportId: "report-ngram-1" },
  { ...span("08", 14, 0, 45), scheduleId: "demand-pulse", agentId: "diego", title: "Demand pulse", kind: "team", state: "skipped" },
  { ...span("09", 8), scheduleId: "morning-digest", agentId: "dana", title: "Morning digest", kind: "assistant", state: "missed" },
];

const pageOn = (week: string, today: string) => ({
  router: {
    routes: [{ path: "*", element: <SchedulePage schedules={PINNED_SCHEDULES} occurrences={MIXED_WEEK} week={week} today={today} /> }],
    initialEntries: [`/schedule?week=${week}`],
  },
});

/** Planned/running/missed week with the today chrome pinned to Tue Oct 6. */
export const PinnedWeekStates: Story = {
  name: "Pinned week · every live state, overlap, pinned today",
  parameters: {
    ...pageOn("2026-10-04", "2026-10-06"),
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // One block per hand-stamped state, the skipped/missed struck through.
    expect(canvas.getByTitle(/^Morning digest · Upcoming ·/)).toHaveClass("border-dashed");
    expect(canvas.getByTitle(/^Weekly literature sweep · Running ·/)).toHaveClass("ring-1");
    expect(canvas.getByTitle(/^Morning digest · Posted ·/)).toBeInTheDocument();
    expect(canvas.getByTitle(/^Weekly literature sweep · Accepted ·/)).toBeInTheDocument();
    expect(canvas.getByTitle(/^Demand pulse · Skipped ·/)).toHaveClass("line-through");
    expect(canvas.getByTitle(/^Morning digest · Missed ·/)).toHaveClass("line-through");

    // The Tuesday overlap splits into two side-by-side columns.
    const left = canvas.getByTitle(/^Morning digest · Upcoming ·/);
    const right = canvas.getByTitle(/^Weekly literature sweep · Running ·/);
    expect(left.getAttribute("style")).toContain("left: calc(0% + 2px)");
    expect(right.getAttribute("style")).toContain("left: calc(50% + 2px)");

    // The pinned today: the Oct 6 column is selected in the mini calendar and the now-line
    // renders (its position is the wall clock by design — the data around it is pinned).
    expect(canvas.getByRole("button", { name: "Tuesday, October 6 · 2 routines" })).toHaveAttribute("aria-pressed", "true");
    expect(canvasElement.querySelector('[aria-label="Now"]')).not.toBeNull();

    // Rail counts follow the pinned data: Dana 3, Elliot 2, Diego 1 (rail-scoped, as above).
    const rail = () => canvas.getByText("Agents").closest("section")!;
    expect(within(rail()).getByRole("button", { name: /Dana/ })).toBeInTheDocument();
    expect(within(within(rail()).getByRole("button", { name: /Dana/ })).getByText("3")).toBeInTheDocument();
    expect(within(within(rail()).getByRole("button", { name: /Elliot/ })).getByText("2")).toBeInTheDocument();
    expect(within(within(rail()).getByRole("button", { name: /Diego/ })).getByText("1")).toBeInTheDocument();
  },
};

/** An empty week: no blocks, no agent rows, no markers — the routines still listed. */
export const EmptyWeek: Story = {
  name: "Empty week · quiet grid, rail intact",
  parameters: {
    router: {
      routes: [{ path: "*", element: <SchedulePage schedules={PINNED_SCHEDULES} occurrences={[]} week="2026-10-04" today="2026-10-06" /> }],
      initialEntries: ["/schedule?week=2026-10-04"],
    },
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText("Oct 4 – 10")).toBeInTheDocument();
    expect(canvas.queryByTitle(/Morning digest ·/)).toBeNull();
    expect(canvas.queryByTitle(/Weekly literature sweep ·/)).toBeNull();

    // No agent rows without occurrences; the three routines still list, enabled.
    const agentsSection = canvas.getByText("Agents").closest("section")!;
    expect(within(agentsSection).queryAllByRole("button")).toHaveLength(0);
    const routinesSection = canvas.getByText("Routines").closest("section")!;
    expect(within(routinesSection).getAllByRole("switch")).toHaveLength(3);
    expect(canvas.getByRole("switch", { name: "Pause Morning digest" })).toBeInTheDocument();
    expect(canvas.getByText("Daily at 8:00 AM")).toBeInTheDocument();

    // And no routine markers on any mini-calendar day.
    expect(canvas.queryAllByRole("button", { name: /routine/ })).toHaveLength(0);
  },
};

/** The composed page at a narrow desktop width: grid and rail both up. */
export const ComposedNarrow: Story = {
  name: "Composed · narrow",
  parameters: {
    ...pageOn("2026-10-04", "2026-10-06"),
    viewport: { defaultViewport: "narrow", viewports: VIEWPORTS },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Oct 4 – 10")).toBeInTheDocument();
    // The aside rail survives the narrow width next to the grid.
    expect(canvas.getByText("Routines")).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Previous week" })).toBeInTheDocument();
    expect(canvas.getAllByTitle(/^Morning digest ·/)).toHaveLength(3);
  },
};
