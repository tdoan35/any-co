import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Input } from "./input";

const meta = {
  title: "UI/Input",
  component: Input,
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The one state row: placeholder, filled, invalid and disabled side by side. */
function InputRow() {
  return (
    <div className="flex w-96 flex-col gap-3">
      <Input aria-label="Placeholder" placeholder="Tell Dana what you need…" />
      <Input aria-label="Filled" defaultValue="ngram-360m" />
      <Input aria-label="Invalid" defaultValue="not a number" aria-invalid />
      <Input aria-label="Disabled" placeholder="Locked" disabled />
    </div>
  );
}

export const States: Story = {
  name: "States",
  render: () => <InputRow />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Placeholder state: the hint is the muted-foreground layer, not a value.
    const placeholder = canvas.getByLabelText("Placeholder");
    expect(placeholder).toHaveAttribute("data-slot", "input");
    expect(placeholder).toHaveAttribute("placeholder", "Tell Dana what you need…");
    expect(placeholder.classList.contains("placeholder:text-muted-foreground")).toBe(true);

    // Filled state: a real controlled-by-the-app input carries its value in the DOM.
    expect(canvas.getByLabelText("Filled")).toHaveValue("ngram-360m");

    // Invalid state: aria-invalid flips the destructive token pair on the same input.
    const invalid = canvas.getByLabelText("Invalid");
    expect(invalid).toHaveAttribute("aria-invalid", "true");
    expect(invalid.classList.contains("aria-invalid:border-destructive")).toBe(true);
    expect(invalid.classList.contains("aria-invalid:ring-3")).toBe(true);

    // Disabled state: actually disabled, with the dimmed input surface.
    const disabled = canvas.getByLabelText("Disabled");
    expect(disabled).toBeDisabled();
    expect(disabled.classList.contains("disabled:bg-input/50")).toBe(true);
    expect(disabled.classList.contains("disabled:opacity-50")).toBe(true);
  },
};

/** Typing is real: the value lands in the input, character by character. */
export const Typing: Story = {
  render: () => <Input aria-label="Editable" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Editable");

    const user = userEvent.setup();
    await user.type(input, "ngram-360m");
    expect(input).toHaveValue("ngram-360m");

    // Backspace edits too — not a read-only display.
    await user.type(input, "{backspace}");
    expect(input).toHaveValue("ngram-360");
  },
};

/** Keyboard focus lands on the input and paints the ring/border focus pair. */
export const Focus: Story = {
  render: () => <Input aria-label="Focusable" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Focusable");

    // Signature focus-visible classes are authored on the component...
    expect(input.classList.contains("focus-visible:border-ring")).toBe(true);
    expect(input.classList.contains("focus-visible:ring-3")).toBe(true);
    expect(input.classList.contains("focus-visible:ring-ring/50")).toBe(true);

    // ...and keyboard focus actually arrives here (tab order reaches the field).
    const user = userEvent.setup();
    await user.tab();
    expect(input).toHaveFocus();
  },
};

/** A disabled input swallows typing: the value never changes. */
export const Disabled: Story = {
  render: () => <Input aria-label="Frozen" defaultValue="sealed" disabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Frozen");

    expect(input).toBeDisabled();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(input, "x");
    expect(input).toHaveValue("sealed");
  },
};
