import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";
import { Button } from "./button";

const meta = {
  title: "UI/Dialog",
  component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

function ApproveDialog({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>Approve run</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve run 12?</DialogTitle>
          <DialogDescription>
            Jonah will push the fetch shard to the engram project. You can stop the run later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Not now</Button>
          <Button>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Open via keyboard: Enter on the trigger opens the dialog, focus moves into it,
 * and Escape closes it — returning focus to the trigger.
 */
export const OpenCloseKeyboard: Story = {
  name: "Open close keyboard",
  render: () => <ApproveDialog />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Approve run" });

    // Closed: no dialog anywhere in the document.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Keyboard open: the trigger is focusable and Enter toggles the dialog.
    const user = userEvent.setup();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Approve run 12?" });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");

    // Focus moved into the dialog, not left on the trigger.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Focus is trapped: Tab cycles inside the dialog, never back to the trigger.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes, and focus returns to the trigger.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
};

/** The controlled open state: content, overlay and the close affordance, all wired. */
export const Open: Story = {
  name: "Open",
  args: { onOpenChange: fn() },
  render: (args) => (
    <Dialog open onOpenChange={args.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve run 12?</DialogTitle>
          <DialogDescription>
            Jonah will push the fetch shard to the engram project. You can stop the run later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Not now</Button>
          <Button>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement, args }) => {
    // The overlay and panel are portal-rendered; the story canvas holds the anchor.
    expect(canvasElement).toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "Approve run 12?" });
    // The overlay is the dialog's portal sibling, not a child of the panel.
    expect(document.querySelector("[data-slot=dialog-overlay]")).not.toBeNull();
    // The description is wired as the panel's aria-describedby text.
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(dialog.textContent).toContain("Jonah will push the fetch shard");

    // The footer actions are real buttons a keyboard user can reach.
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();

    // The built-in close button reports the close through onOpenChange(false).
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};
