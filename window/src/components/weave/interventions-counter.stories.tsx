// Autonomy counter stories. Data comes from the fixtures; the counter itself is the
// judges' view of the human ledger — count, category split, and the entry list.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { InterventionsCounter } from "./interventions-counter";
import { interventionsFixture } from "@fabric/fixtures/interventions";

const meta = {
  title: "Weave/InterventionsCounter",
  decorators: [WithHarness],
  parameters: { a11y: { test: "off" } },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const CounterOpensLedger: Story = {
  name: "Counter opens the ledger",
  render: () => <div className="flex h-12 items-center justify-end border-b px-6"><InterventionsCounter data={interventionsFixture} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("button", { name: /Human interventions: 23/ })).toHaveTextContent("23");
    await userEvent.click(canvas.getByRole("button", { name: /Open the list/ }));

    // The sheet opens on the agents' own decisions, with avatars, newest first.
    const sheet = await within(document.body).findByRole("dialog");
    expect(sheet).toHaveTextContent("Agent decisions · 41");
    expect(sheet.querySelector("ol li")?.textContent).toContain("Split the blocked release check");

    // The human tab: newest first, every category as a filter, entries carry who and reason.
    await userEvent.click(within(sheet).getByRole("tab", { name: /Human interventions · 23/ }));
    expect(within(sheet).getByRole("button", { name: "steering · 8", hidden: true })).toBeInTheDocument();
    // Newest first: the 03:41Z entry leads (locale-independent).
    expect(sheet.querySelector("ol li")?.textContent).toContain("Picked option 2");
    expect(sheet).toHaveTextContent("Rotated the art provider key");
  },
};

export const CategoryFilterNarrows: Story = {
  name: "Category filter narrows the list",
  render: () => <div className="flex h-12 items-center justify-end border-b px-6"><InterventionsCounter data={interventionsFixture} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Open the list/ }));
    const sheet = await within(document.body).findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("tab", { name: /Human interventions/ }));
    expect(sheet.querySelectorAll("ol li")).toHaveLength(5);

    await userEvent.click(within(sheet).getByRole("button", { name: "steering · 8" }));
    expect(within(sheet).queryByText("Rotated the art provider key")).toBeNull();
    expect(within(sheet).getByText("Told the Studio Head to drop the roguelike pitch")).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole("button", { name: /all · 23/ }));
    expect(sheet.querySelectorAll("ol li")).toHaveLength(5);
  },
};
