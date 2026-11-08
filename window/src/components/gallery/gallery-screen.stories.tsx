// Gallery stories. Data comes straight from the fixtures (packages/fixtures/src/gallery.ts):
// the same world mock mode serves, with candidates from every provider and verdict, a
// contact sheet without gate numbers, and several candidates per asset.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { GalleryScreen, familyOf } from "./gallery-screen";
import { galleryEntries, galleryRepos } from "@fabric/fixtures/gallery";

const meta = {
  title: "Gallery/GalleryScreen",
  decorators: [WithHarness],
  parameters: { a11y: { test: "off" } },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const GroupsCandidatesByAsset: Story = {
  name: "Candidates sit side by side per asset",
  render: () => <div className="h-[720px]"><GalleryScreen repos={galleryRepos} entries={galleryEntries} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hero = canvas.getAllByRole("button", { name: /sprite-hero, .* Open details/ });
    expect(hero.length).toBe(3); // pixellab + comfy + openai candidates, side by side
    // The header counts the world: 7 assets, 12 candidates.
    expect(canvas.getByText("7 assets · 12 candidates")).toBeInTheDocument();
  },
};

export const FiltersNarrowTheGrid: Story = {
  name: "Provider and verdict filters narrow the grid",
  render: () => <div className="h-[720px]"><GalleryScreen repos={galleryRepos} entries={galleryEntries} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByRole("button", { name: /Open details/ })).toHaveLength(12);
    await userEvent.click(canvas.getByRole("button", { name: "comfy" }));
    expect(canvas.getAllByRole("button", { name: /Open details/ })).toHaveLength(3);
    await userEvent.click(canvas.getByRole("button", { name: /^accepted$/ }));
    expect(canvas.getAllByRole("button", { name: /Open details/ })).toHaveLength(2);
    // Back to everything.
    await userEvent.click(canvas.getAllByRole("button", { name: /^all$/ })[0]);
    await userEvent.click(canvas.getAllByRole("button", { name: /^all$/ })[1]);
    expect(canvas.getAllByRole("button", { name: /Open details/ })).toHaveLength(12);
  },
};

export const LightboxShowsGateAndReason: Story = {
  name: "Lightbox shows the gate numbers and reason",
  render: () => <div className="h-[720px]"><GalleryScreen repos={galleryRepos} entries={galleryEntries} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /sprite-hero, comfy, rejected/ }));
    const dialog = await within(document.body).findByRole("dialog");
    expect(dialog).toHaveTextContent("Palette drifted past the lock");
    expect(dialog).toHaveTextContent("paletteOk"); // gate numbers, verbatim
    expect(dialog).toHaveTextContent("run-a2");
    await userEvent.keyboard("{Escape}");
  },
};

export const EmptyGallery: Story = {
  name: "Empty gallery explains itself",
  render: () => <div className="h-[720px]"><GalleryScreen repos={[]} entries={[]} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Nothing in the gallery yet")).toBeInTheDocument();
    expect(canvas.getByText(/merge their branches/)).toBeInTheDocument();
  },
};

/** familyOf drives the family filter; sprites/tiles/ui/capsule/sheets from the asset id. */
export const FamilyFromAssetId: Story = {
  name: "Family comes from the asset id",
  render: () => {
    const families = ["sprite-hero", "tile-grass", "ui-healthbar", "capsule-main", "sheet-pass-1", "trailer"].map((a) => `${a} → ${familyOf(a)}`);
    return <ul data-testid="families">{families.map((f) => <li key={f}>{f}</li>)}</ul>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("sprite-hero → sprites")).toBeInTheDocument();
    expect(canvas.getByText("tile-grass → tiles")).toBeInTheDocument();
    expect(canvas.getByText("ui-healthbar → ui")).toBeInTheDocument();
    expect(canvas.getByText("capsule-main → capsule")).toBeInTheDocument();
    expect(canvas.getByText("sheet-pass-1 → sheets")).toBeInTheDocument();
    expect(canvas.getByText("trailer → other")).toBeInTheDocument();
  },
};
