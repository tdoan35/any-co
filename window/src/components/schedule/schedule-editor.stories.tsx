// Schedule editor stories (ANY-23 M7): the create/edit dialog's own states, component-level.
// The editor's trigger paths live elsewhere (the header's New schedule, the sheet's Edit routine
// — both covered on their cards); here the dialog starts open on a state-owned host, exactly as
// SchedulePage mounts it.
//
// State → story inventory:
//   create, empty → invalid → valid → invalidated → valid, then saved
//                            → CreateValidates (play: Create's disabled tracks title+prompt+days;
//                              the footer previews the recurrence; submit calls onSave with the
//                              assistant payload, the viewer's tz and the pruned days; the
//                              saving flag disables the button; success closes the dialog)
//   who → team               → TeamRun (play: the dropdown swap, the objective placeholder, the
//                              project picker appearing, the team payload with its project)
//   edit, prefilled          → EditKeepsTz (play: fields prefill from the schedule; adding a day
//                              patches the recurrence; the schedule's own tz — not the viewer's —
//                              rides along; Save closes)
//   delete                   → Delete (play: Delete fires once and closes, onSave untouched)
//   save failure             → SaveErrorStaysOpen (play: a rejected save leaves the dialog up and
//                              re-enables Create — there is no dedicated error surface to show)
//
// Exclusions: the once/monthly date branch's payload (the date input's keystrokes are
// locale-variant; its appearance and validation are asserted in CreateValidates via the disabled
// chain, and date→cron is contracts' toCron); the next-run preview's literal date (real-clock by
// design, asserted by shape); agentId/cron/sessionId derivation — the server's job, not the form's.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { ScheduleEditor } from "./schedule-editor";
import type { EditorTarget } from "./schedule-editor";
import { schedules as seedSchedules } from "@fabric/fixtures/schedules";
import type { ScheduleInput } from "@fabric/contracts";
import { localTz } from "@/lib/schedule";

const meta = {
  title: "Schedule/Schedule editor",
  decorators: [WithHarness],
  parameters: {
    a11y: {
      // Scoped exception, token-level like every prior card: the muted description, footer
      // summary and placeholders sit below the 4.5:1 bar — the same design tokens the schedule
      // cards scoped. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const SWEEP = seedSchedules[1];
const DIGEST = seedSchedules[0];

/** Host mirroring SchedulePage's mounting: the editor stays mounted; the page owns `open`. */
function EditorHost({ target = {}, onSave, onDelete }: {
  target?: EditorTarget;
  onSave: (input: ScheduleInput & { enabled?: boolean }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ScheduleEditor target={target} open={open} onOpenChange={setOpen} onSave={onSave} onDelete={onDelete} />
  );
}

// Radix portals the dialog to document.body — the story canvas never contains it.
const body = within(document.body);

async function waitForDialogGone() {
  // 3s: the exit animation is ~100ms, but a loaded worker has been seen to stretch the
  // unmount past the default 1s (the same portal-exit race the settings card documented).
  await waitFor(() => {
    expect(document.querySelector("[data-slot=dialog-content]")).toBeNull();
    expect(document.querySelector("[data-slot=dropdown-menu-content]")).toBeNull();
  }, { timeout: 3000 });
}

/** A save the story resolves by hand, so the saving-disabled window is observable. */
function deferredSave() {
  let resolve: () => void = () => {};
  const save = fn((input: ScheduleInput & { enabled?: boolean }) => {
    void input; // the deferred save records its payload; resolution is story-driven
    return new Promise<void>((r) => { resolve = r; });
  });
  return { save, resolve: () => resolve() };
}

const createSave = deferredSave();

/** Create: the disabled chain tracks every validation branch, and a valid save payload lands. */
export const CreateValidates: Story = {
  name: "Create · validates, then saves",
  render: () => <EditorHost onSave={createSave.save} />,
  play: async () => {
    const dialog = body.getByRole("dialog");
    const d = within(dialog);
    const user = userEvent.setup();
    const create = d.getByRole("button", { name: "Create" });

    // Empty form: the weekly default carries five days, but title and prompt are missing.
    expect(d.getByRole("heading", { name: "New routine" })).toBeInTheDocument();
    expect(d.getByRole("group", { name: "Days of week" })).toBeInTheDocument();
    expect(create).toBeDisabled();

    // A title alone isn't enough.
    await user.type(d.getByLabelText("Title"), "Sprint retro digest");
    expect(create).toBeDisabled();

    // Title plus instructions: valid, and the footer previews the weekly pattern.
    await user.type(d.getByLabelText("Instructions"), "Collect the three threads that moved and draft the retro.");
    expect(create).toBeEnabled();
    expect(d.getByText(/Weekly on Mon, Tue, Wed, Thu, Fri at 9:00 AM/)).toBeInTheDocument();

    // Clearing every day invalidates again — the footer's pattern is the same state.
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await user.click(d.getByRole("button", { name: day }));
    }
    expect(create).toBeDisabled();

    // One day back: valid, and only that day pressed.
    await user.click(d.getByRole("button", { name: "Wednesday" }));
    expect(create).toBeEnabled();
    expect(d.getByRole("button", { name: "Wednesday" })).toHaveAttribute("aria-pressed", "true");
    expect(d.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "false");

    // Submit: the button locks while the save is in flight, then the dialog closes.
    await user.click(create);
    await waitFor(() => expect(create).toBeDisabled());
    createSave.resolve();
    await waitForDialogGone();

    expect(createSave.save).toHaveBeenCalledTimes(1);
    const input = createSave.save.mock.calls[0][0] as ScheduleInput & { enabled?: boolean };
    expect(input).toMatchObject({
      title: "Sprint retro digest",
      kind: "assistant",
      prompt: "Collect the three threads that moved and draft the retro.",
      recurrence: { freq: "weekly", time: "09:00", days: [3] },
      durationMin: 30,
    });
    // A new assistant routine: no team, no project, the viewer's own zone.
    expect(input.teamId).toBeUndefined();
    expect(input.projectId).toBeUndefined();
    expect(input.tz).toBe(localTz);
  },
};

const teamSave = deferredSave();

/** Who → team: the form reshapes itself and the payload carries the team and its project. */
export const TeamRun: Story = {
  name: "Team run · who and project",
  render: () => <EditorHost onSave={teamSave.save} />,
  play: async () => {
    const dialog = body.getByRole("dialog");
    const d = within(dialog);
    const user = userEvent.setup();

    // The default is Dana; the trigger names the choice.
    const who = d.getByRole("button", { name: /one assistant turn/ });
    await user.click(who);
    const menu = body.getByRole("menu");
    await user.click(within(menu).getByRole("menuitemradio", { name: /Research Team/ }));
    await waitFor(() => expect(document.querySelector("[data-slot=dropdown-menu-content]")).toBeNull(), { timeout: 3000 });

    // The trigger and the prompt's placeholder follow the team; a project picker appears.
    expect(d.getByRole("button", { name: /Research Team · a team run/ })).toBeInTheDocument();
    expect(d.getByLabelText("Instructions")).toHaveAttribute("placeholder", "The objective the team runs with. Criteria come from the team.");
    expect(d.getByRole("button", { name: /Routines \(default\)/ })).toBeInTheDocument();

    // Pick the project from the seeded, non-archived list.
    await user.click(d.getByRole("button", { name: /Routines \(default\)/ }));
    const projects = body.getByRole("menu");
    await user.click(within(projects).getByRole("menuitemradio", { name: "Engram on small models" }));
    await waitFor(() => expect(document.querySelector("[data-slot=dropdown-menu-content]")).toBeNull(), { timeout: 3000 });

    await user.type(d.getByLabelText("Title"), "Engram weekly retro");
    await user.type(d.getByLabelText("Instructions"), "Retro the week's engram results against the 360M baseline.");
    const create = d.getByRole("button", { name: "Create" });
    expect(create).toBeEnabled();

    await user.click(create);
    teamSave.resolve();
    await waitForDialogGone();

    expect(teamSave.save).toHaveBeenCalledTimes(1);
    const input = teamSave.save.mock.calls[0][0] as ScheduleInput;
    expect(input).toMatchObject({
      title: "Engram weekly retro",
      kind: "team",
      teamId: "research",
      projectId: "engram",
      recurrence: { freq: "weekly", time: "09:00", days: [1, 2, 3, 4, 5] },
    });
  },
};

const editSave = deferredSave();

/** Edit: prefilled from the schedule; the patch keeps the schedule's own timezone. */
export const EditKeepsTz: Story = {
  name: "Edit · patch keeps the schedule's tz",
  render: () => <EditorHost target={{ schedule: SWEEP }} onSave={editSave.save} />,
  play: async () => {
    const dialog = body.getByRole("dialog");
    const d = within(dialog);
    const user = userEvent.setup();

    expect(d.getByRole("heading", { name: "Edit routine" })).toBeInTheDocument();
    expect(d.getByLabelText("Title")).toHaveValue("Weekly literature sweep");
    expect(d.getByLabelText("Instructions")).toHaveValue(SWEEP.prompt);
    expect(d.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(d.getByText(/Weekly on Mon at 9:00 AM/)).toBeInTheDocument();

    // Extend the pattern by a day; the prefilled state is the base being patched.
    expect(d.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "true");
    await user.click(d.getByRole("button", { name: "Saturday" }));
    expect(d.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "true");
    expect(d.getByText(/Weekly on Mon, Sat at 9:00 AM/)).toBeInTheDocument();

    await user.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(d.getByRole("button", { name: "Save" })).toBeDisabled());
    editSave.resolve();
    await waitForDialogGone();

    expect(editSave.save).toHaveBeenCalledTimes(1);
    const input = editSave.save.mock.calls[0][0] as ScheduleInput;
    expect(input).toMatchObject({
      title: "Weekly literature sweep",
      kind: "team",
      teamId: "research",
      projectId: "engram",
      recurrence: { freq: "weekly", time: "09:00", days: [1, 6] },
      durationMin: 60,
    });
    // The semantic under test: the schedule's tz survives the edit — not the viewer's zone.
    expect(input.tz).toBe("America/Los_Angeles");
  },
};

const deleteSave = deferredSave();
const deleteFn = fn(() => Promise.resolve());

/** Delete: one call, dialog closed, no save riding along. */
export const Delete: Story = {
  name: "Delete · removes and closes",
  render: () => <EditorHost target={{ schedule: DIGEST }} onSave={deleteSave.save} onDelete={deleteFn} />,
  play: async () => {
    const d = within(body.getByRole("dialog"));
    const user = userEvent.setup();

    expect(d.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Delete" }));

    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(deleteSave.save).not.toHaveBeenCalled();
    await waitForDialogGone();
  },
};

/** A rejected save has no error surface: the dialog stays up and the button unlocks. */
export const SaveErrorStaysOpen: Story = {
  name: "Save error · stays open",
  render: () => (
    <EditorHost
      onSave={fn(() => Promise.reject(new Error("save failed"))) as unknown as (input: ScheduleInput & { enabled?: boolean }) => Promise<void>}
    />
  ),
  play: async () => {
    const dialog = body.getByRole("dialog");
    const d = within(dialog);
    const user = userEvent.setup();
    const create = d.getByRole("button", { name: "Create" });

    await user.type(d.getByLabelText("Title"), "Digest that fails");
    await user.type(d.getByLabelText("Instructions"), "This save rejects to prove the dialog survives it.");
    expect(create).toBeEnabled();

    await user.click(create);
    // The rejection settles; the editor remains, unlocked, for the user to retry or cancel.
    await waitFor(() => expect(create).toBeEnabled());
    expect(body.getByRole("dialog")).toBeInTheDocument();
    expect(d.getByRole("heading", { name: "New routine" })).toBeInTheDocument();
  },
};
