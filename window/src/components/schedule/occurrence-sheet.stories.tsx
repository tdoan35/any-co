// Occurrence sheet stories (ANY-23 M7): the selected-occurrence sheet's own states,
// component-level. The route-level open/close already lives in schedule-screen's FixtureWeek;
// here every state is hand-stamped — shape-for-shape what `mockOccurrences` emits for the seed
// (sessionId from the schedule, run/task/report ids shaped like the seeded fires').
//
// State → story inventory:
//   planned — upcoming assistant slot on an enabled schedule
//                            → Planned (play: the state pill, the tz-shaped time line, the thread
//                              link and no run links; Run now/Skip/Edit/Pause each fire their
//                              callback exactly once; Escape and the X both hand back through
//                              onClose, and the host reopens the sheet)
//   fired — an accepted team run with task/loop/report ids
//                            → Fired (play: the three deep links' hrefs, the team line, the
//                              accepted pill, the recurrence line in the schedule's own tz)
//   skipped on a paused schedule
//                            → SkippedPaused (play: skipped pill, Resume label, Resume fires —
//                              the enabled/disabled pair, with Pause covered in Planned)
//   busy                     → Busy (play: Run now/Skip/Pause disabled, Edit still live, and a
//                              disabled control's click calls nothing)
//
// Exclusions: a closed sheet with no occurrence (the component is `open={!!occurrence}` — Radix
// mounts nothing, and the closed→open leg is the reopen in Planned); the blocked/stopped/missed/
// failed pill tints (same STATE map, exercised in week-grid's every-state story); literal clock
// text — times render in the viewer's zone by design, so assertions stay shape-level.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { OccurrenceSheet } from "./occurrence-sheet";
import { schedules as seedSchedules } from "@fabric/fixtures/schedules";
import type { Occurrence, Schedule } from "@fabric/contracts";
import { localTz } from "@/lib/schedule";

const meta = {
  title: "Schedule/Occurrence sheet",
  decorators: [WithHarness],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior card: the muted prompt, meta lines and
      // link chips sit below the 4.5:1 bar — the same design tokens the schedule cards scoped.
      // Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Mid-week, mid-hour slots so every timezone agrees on the day; the sheet shows times in the
// viewer's zone, so assertions stay shape-level, never a literal clock.
const at = (day: string, h: number, m = 0) => new Date(`2026-10-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-07:00`).toISOString();
const span = (day: string, h: number, m = 0, dur = 30) => {
  const end = h * 60 + m + dur;
  return { at: at(day, h, m), end: at(day, Math.floor(end / 60) % 24, end % 60) };
};

const DIGEST = seedSchedules[0];
const SWEEP = seedSchedules[1];
const PAUSED_DIGEST: Schedule = { ...DIGEST, enabled: false };

const PLANNED: Occurrence = {
  ...span("06", 9),
  scheduleId: DIGEST.id, agentId: DIGEST.agentId, title: DIGEST.title, kind: DIGEST.kind,
  state: "upcoming", sessionId: DIGEST.sessionId,
};
const FIRED: Occurrence = {
  ...span("05", 9, 0, 60),
  scheduleId: SWEEP.id, agentId: SWEEP.agentId, title: SWEEP.title, kind: SWEEP.kind,
  state: "accepted", runId: "run-ngram-1", taskId: "ngram-135m", reportId: "report-ngram-1", sessionId: SWEEP.sessionId,
};
const SKIPPED: Occurrence = {
  ...span("07", 8),
  scheduleId: DIGEST.id, agentId: DIGEST.agentId, title: DIGEST.title, kind: DIGEST.kind,
  state: "skipped", sessionId: DIGEST.sessionId,
};

interface SheetActions {
  onRunNow: () => void;
  onSkip: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onClose: () => void;
}

/** Host mirroring SchedulePage's mounting: state-owned occurrence the sheet hands back via onClose. */
function SheetHost({ occurrence, schedule, busy = false, actions }: {
  occurrence: Occurrence;
  schedule: Schedule;
  busy?: boolean;
  actions: SheetActions;
}) {
  const [current, setCurrent] = useState<Occurrence | null>(occurrence);
  return (
    <div className="p-6">
      <button type="button" className="rounded-md border px-2 py-1 text-xs" disabled={!!current} onClick={() => setCurrent(occurrence)}>
        Reopen the sheet
      </button>
      <OccurrenceSheet
        occurrence={current}
        schedule={schedule}
        busy={busy}
        onRunNow={actions.onRunNow}
        onSkip={actions.onSkip}
        onEdit={actions.onEdit}
        onToggleEnabled={actions.onToggleEnabled}
        onClose={() => { actions.onClose(); setCurrent(null); }}
      />
    </div>
  );
}

// Radix portals the sheet to document.body — the story canvas never contains it.
const body = within(document.body);

/** Waits until no sheet portal remains (exit animations included), per the settings precedent. */
async function waitForSheetGone() {
  await waitFor(() => expect(document.querySelector("[data-slot=sheet-content]")).toBeNull(), { timeout: 3000 });
}

/** Every sheet story mounts inside the harness router: the sheet's chips are Links. */
const sheetOn = (element: React.ReactElement): { router: { routes: { path: string; element: React.ReactElement }[] } } => ({
  router: { routes: [{ path: "*", element }] },
});

const plannedActions: SheetActions = { onRunNow: fn(), onSkip: fn(), onEdit: fn(), onToggleEnabled: fn(), onClose: fn() };

/** Planned: the pill, the shape-level time line, one link, and every callback exactly once. */
export const Planned: Story = {
  name: "Planned · upcoming assistant run",
  parameters: sheetOn(<SheetHost occurrence={PLANNED} schedule={DIGEST} actions={plannedActions} />),
  play: async () => {
    const sheet = body.getByRole("dialog");
    const s = within(sheet);

    // Title row: the title and the state word; the time line in the viewer's zone, named.
    expect(s.getByText("Morning digest")).toBeInTheDocument();
    expect(s.getByText("upcoming")).toBeInTheDocument();
    expect(s.getByText(/\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/)).toHaveTextContent(localTz);

    // The routine itself: prompt, recurrence in the schedule's own tz, the assistant line.
    expect(s.getByText(DIGEST.prompt)).toBeInTheDocument();
    expect(s.getByText("Daily at 8:00 AM · America/Los_Angeles")).toBeInTheDocument();
    expect(s.getByText("Dana routine — posts into this thread")).toBeInTheDocument();

    // A planned assistant slot has nowhere to link but its thread.
    expect(s.getByRole("link", { name: "Thread" })).toHaveAttribute("href", `/?session=${encodeURIComponent(DIGEST.sessionId)}`);
    expect(s.queryByRole("link", { name: "Task" })).toBeNull();
    expect(s.queryByRole("link", { name: "Loop" })).toBeNull();
    expect(s.queryByRole("link", { name: "Report" })).toBeNull();

    // Each action fires exactly once — the parent owns whatever happens next.
    const user = userEvent.setup();
    await user.click(s.getByRole("button", { name: "Run now" }));
    await user.click(s.getByRole("button", { name: "Skip this one" }));
    await user.click(s.getByRole("button", { name: "Edit routine" }));
    await user.click(s.getByRole("button", { name: "Pause" }));
    expect(plannedActions.onRunNow).toHaveBeenCalledTimes(1);
    expect(plannedActions.onSkip).toHaveBeenCalledTimes(1);
    expect(plannedActions.onEdit).toHaveBeenCalledTimes(1);
    expect(plannedActions.onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(plannedActions.onClose).toHaveBeenCalledTimes(0);

    // Escape hands back through onClose, and the portal leaves the document entirely.
    const user2 = userEvent.setup();
    await user2.keyboard("{Escape}");
    expect(plannedActions.onClose).toHaveBeenCalledTimes(1);
    await waitForSheetGone();

    // The host can bring it back, and the sheet's own X closes it the same way.
    await user2.click(body.getByRole("button", { name: "Reopen the sheet" }));
    expect(body.getByRole("dialog")).toBeInTheDocument();
    await user2.click(within(body.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(plannedActions.onClose).toHaveBeenCalledTimes(2);
    await waitForSheetGone();
  },
};

const firedActions: SheetActions = { onRunNow: fn(), onSkip: fn(), onEdit: fn(), onToggleEnabled: fn(), onClose: fn() };

/** Fired: an accepted team run deep-links to its task, loop and report. */
export const Fired: Story = {
  name: "Fired · accepted team run",
  parameters: sheetOn(<SheetHost occurrence={FIRED} schedule={SWEEP} actions={firedActions} />),
  play: async () => {
    const s = within(body.getByRole("dialog"));

    expect(s.getByText("Weekly literature sweep")).toBeInTheDocument();
    expect(s.getByText("accepted")).toBeInTheDocument();
    expect(s.getByText(SWEEP.prompt)).toBeInTheDocument();
    expect(s.getByText("Weekly on Mon at 9:00 AM · America/Los_Angeles")).toBeInTheDocument();
    expect(s.getByText("Team routine — lands on Work with a report")).toBeInTheDocument();

    // Every artifact the run produced is one click away, exactly as the fires shaped it.
    expect(s.getByRole("link", { name: "Task" })).toHaveAttribute("href", "/work/ngram-135m");
    expect(s.getByRole("link", { name: "Loop" })).toHaveAttribute("href", "/runs/run-ngram-1");
    expect(s.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/reports/report-ngram-1");
    expect(s.getByRole("link", { name: "Thread" })).toHaveAttribute("href", `/?session=${encodeURIComponent(SWEEP.sessionId)}`);

    // Read-only check: no action fired by merely opening a fired run's sheet.
    expect(firedActions.onRunNow).not.toHaveBeenCalled();
  },
};

const skippedActions: SheetActions = { onRunNow: fn(), onSkip: fn(), onEdit: fn(), onToggleEnabled: fn(), onClose: fn() };

/** Skipped on a paused routine: the history stays reachable and the toggle reads Resume. */
export const SkippedPaused: Story = {
  name: "Skipped · paused routine resumes",
  parameters: sheetOn(<SheetHost occurrence={SKIPPED} schedule={PAUSED_DIGEST} actions={skippedActions} />),
  play: async () => {
    const s = within(body.getByRole("dialog"));

    expect(s.getByText("Morning digest")).toBeInTheDocument();
    expect(s.getByText("skipped")).toBeInTheDocument();
    expect(s.getByText("Daily at 8:00 AM · America/Los_Angeles")).toBeInTheDocument();

    // Paused schedule: the enabled/disabled half of the pair — Resume, not Pause.
    expect(s.queryByRole("button", { name: "Pause" })).toBeNull();
    await userEvent.setup().click(s.getByRole("button", { name: "Resume" }));
    expect(skippedActions.onToggleEnabled).toHaveBeenCalledTimes(1);
  },
};

const busyActions: SheetActions = { onRunNow: fn(), onSkip: fn(), onEdit: fn(), onToggleEnabled: fn(), onClose: fn() };

/** Busy: a mutation in flight locks the fire controls but leaves editing open. */
export const Busy: Story = {
  name: "Busy · fire controls locked",
  parameters: sheetOn(<SheetHost occurrence={PLANNED} schedule={DIGEST} busy actions={busyActions} />),
  play: async () => {
    const s = within(body.getByRole("dialog"));
    const user = userEvent.setup();

    expect(s.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(s.getByRole("button", { name: "Skip this one" })).toBeDisabled();
    expect(s.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(s.getByRole("button", { name: "Edit routine" })).toBeEnabled();

    // A disabled control is inert; only Edit gets through — the rest stay uncalled.
    expect(busyActions.onRunNow).not.toHaveBeenCalled();

    await user.click(s.getByRole("button", { name: "Edit routine" }));
    expect(busyActions.onEdit).toHaveBeenCalledTimes(1);
    expect(busyActions.onRunNow).not.toHaveBeenCalled();
    expect(busyActions.onSkip).not.toHaveBeenCalled();
    expect(busyActions.onToggleEnabled).not.toHaveBeenCalled();
  },
};
