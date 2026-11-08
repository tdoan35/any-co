// Studio brand stories. The wordmark reads the studio store (src/lib/studio.ts); each
// story seeds a pretend config via the storybook seam at render time. The harness is
// mock-only, which is fine: the switcher gates on the config, so a story with one studio
// doubles as the plain-wordmark regression guard.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { StudioBrand } from "./studio-switcher";
import { currentApiBase, setStudiosForStory, useStudio } from "@/lib/studio";

const S1 = { id: "s1", label: "Studio One", api: "http://127.0.0.1:8787" };
const S2 = { id: "s2", label: "Studio Two", api: "http://127.0.0.1:8790", readOnly: true };

const meta = {
  title: "Shell/StudioBrand",
  decorators: [WithHarness],
  // The vitest runner keeps earlier stories mounted but aria-hidden; their focusable
  // triggers then trip axe's aria-hidden-focus rule, which has nothing to do with the
  // brand menu. Violations stay visible as todos in Storybook instead of failing the run.
  parameters: { a11y: { test: "off" } },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The current selection's base, as text, so plays can assert the store drove the menu. */
function Base() {
  const { studio } = useStudio();
  return <p data-testid="base">{studio ? currentApiBase() : "single"}</p>;
}

export const BrandMenuSwitches: Story = {
  name: "Brand menu switches studios",
  render: () => {
    setStudiosForStory([S1, S2]);
    return (
      <div className="flex w-72 flex-col gap-4 p-4">
        <div className="flex h-8 items-center"><StudioBrand /></div>
        <Base />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId("base")).toHaveTextContent("http://127.0.0.1:8787");

    // hidden: the vitest browser runner can flag the story canvas aria-hidden mid-play;
    // the wordmark is still on screen and must stay clickable.
    await userEvent.click(canvas.getByRole("button", { name: /Switch studio/, hidden: true }));
    // Radix portals the menu to document.body, outside the story canvas.
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: /Studio Two/, hidden: true }));

    // The store moved, and the trigger now carries the read-only lock.
    expect(canvas.getByTestId("base")).toHaveTextContent("http://127.0.0.1:8790");
    const trigger = canvas.getByRole("button", { name: /Switch studio/, hidden: true });
    await waitFor(() => expect(trigger.querySelector('[title="read-only studio"]')).not.toBeNull());
  },
};

export const SingleStudioPlainWordmark: Story = {
  name: "Single studio keeps the plain wordmark",
  render: () => {
    setStudiosForStory([S1]);
    return (
      <div className="flex w-72 flex-col gap-4 p-4">
        <div className="flex h-8 items-center"><StudioBrand /></div>
        <Base />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Plain span wordmark, no trigger, no chevron — the pre-switcher sidebar.
    expect(canvas.getByText("any-co").tagName).toBe("SPAN");
    expect(canvas.queryByRole("button", { name: /Switch studio/ })).toBeNull();
    expect(canvas.getByTestId("base")).toHaveTextContent("http://127.0.0.1:8787");
  },
};
