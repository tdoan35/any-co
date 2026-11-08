// Studio switcher stories. The switcher reads the studio store (src/lib/studio.ts); each
// story seeds a pretend config via the storybook seam at render time. The harness is
// mock-only (VITE_API_MODE unset), which is fine: the switcher gates on the config, so a
// story with one studio doubles as the "renders nothing" regression guard.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { StudioSwitcher } from "./studio-switcher";
import { currentApiBase, setStudiosForStory, useStudio } from "@/lib/studio";

const S1 = { id: "s1", label: "Studio One", api: "http://127.0.0.1:8787" };
const S2 = { id: "s2", label: "Studio Two", api: "http://127.0.0.1:8790", readOnly: true };

const meta = {
  title: "Shell/StudioSwitcher",
  decorators: [WithHarness],
  // The vitest runner keeps earlier stories mounted but aria-hidden; their focusable
  // triggers then trip axe's aria-hidden-focus rule, which has nothing to do with the
  // switcher. Violations stay visible as todos in Storybook instead of failing the run.
  parameters: { a11y: { test: "off" } },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The current selection, rendered as text so plays can assert the store drove the UI. */
function Selection() {
  const { studio } = useStudio();
  return <p data-testid="base">{studio ? currentApiBase() : "single"}</p>;
}

/** Seeds two studios at render time; no story depends on a previous one's pick. */
const withStudios = (element: React.ReactElement) => () => {
  setStudiosForStory([S1, S2]);
  return element;
};

export const SwitchesBase: Story = {
  name: "Switch swaps the API base",
  render: withStudios(
    <div className="w-64 p-4">
      <StudioSwitcher />
      <Selection />
    </div>,
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // hidden: the vitest browser runner can flag the story canvas aria-hidden mid-play;
    // the switcher is still visible on screen and must stay clickable.
    await userEvent.click(canvas.getByRole("button", { name: /Switch studio/, hidden: true }));
    // Radix portals the menu to document.body, outside the story canvas.
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: /Studio Two/, hidden: true }));

    // The store moved: new base, remembered label, read-only tag on the trigger.
    expect(canvas.getByTestId("base")).toHaveTextContent("http://127.0.0.1:8790");
    expect(canvas.getByRole("button", { name: /Switch studio/, hidden: true })).toHaveTextContent("Studio Two");
    expect(canvas.getByRole("button", { name: /Switch studio/, hidden: true })).toHaveTextContent("read-only");
  },
};

export const SingleStudioRendersNothing: Story = {
  name: "Single studio renders nothing",
  render: () => {
    setStudiosForStory([S1]);
    return <div data-testid="host"><StudioSwitcher /></div>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId("host").children).toHaveLength(0);
  },
};
