import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

const meta = {
  title: "UI/Tokens",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Typography: the app's three font roles — sans body, mono code, heading — plus the
 * size/weight ladder. Families come from the --app-font-* token chain, so the
 * Settings → Appearance swap works here exactly as in the app.
 */
export const Typography: Story = {
  name: "Typography",
  render: () => (
    <div className="flex w-96 flex-col gap-2">
      <span data-role="sans" className="font-sans text-base">Geist sans body</span>
      <span data-role="mono" className="font-mono text-sm">ngram-360m · fetch shard</span>
      <h3 data-role="heading" className="font-heading text-base font-medium">Heading role</h3>
      <p data-role="muted" className="text-sm text-muted-foreground">Muted body text</p>
      <p data-role="tabular" className="text-xs tabular-nums">0123456789</p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const role = (name: string) => canvasElement.querySelector<HTMLElement>(`[data-role=${name}]`)!;

    // Font roles resolve to the token chain: Geist by default for both sans and mono...
    const sans = getComputedStyle(role("sans"));
    expect(sans.fontFamily).toContain("Geist Variable");
    const mono = getComputedStyle(role("mono"));
    expect(mono.fontFamily).toContain("Geist Mono Variable");

    // ...and heading is wired to the sans family by default (--font-heading).
    const heading = getComputedStyle(role("heading"));
    expect(heading.fontFamily).toContain("Geist Variable");

    // Muted text uses the muted-foreground token, not a hardcoded grey.
    expect(role("muted").classList.contains("text-muted-foreground")).toBe(true);
    expect(getComputedStyle(role("muted")).color).not.toBe(getComputedStyle(role("sans")).color);

    // Numeric UI aligns in tables via tabular-nums.
    expect(getComputedStyle(role("tabular")).fontVariantNumeric).toContain("tabular-nums");
  },
};

/** Surfaces (light): the layered neutrals — background, card, popover, muted, border. */
export const Surfaces: Story = {
  name: "Surfaces",
  parameters: { layout: "padded" },
  render: () => (
    <div className="flex w-96 flex-col gap-2">
      <div data-surface="background" className="bg-background border border-foreground/10 p-2">background</div>
      <div data-surface="card" className="bg-card text-card-foreground p-2">card</div>
      <div data-surface="popover" className="bg-popover text-popover-foreground p-2">popover</div>
      <div data-surface="muted" className="bg-muted p-2">muted</div>
      <span data-surface="pill" className="rounded-full bg-foreground/5 px-1.5 py-px text-[10px]">foreground/5</span>
    </div>
  ),
  play: async ({ canvasElement }) => {
    // Every surface reads its token; light theme keeps the page background bright.
    const body = getComputedStyle(document.body).backgroundColor;
    expect(body).not.toBe("rgba(0, 0, 0, 0)");

    const card = getComputedStyle(canvasElement.querySelector("[data-surface=card]")!);
    expect(card.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    // The light theme is explicitly not the dark one.
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  },
};

/**
 * The same surfaces under the dark theme — one implementation, two palettes: the
 * `.dark` class on <html> flips the token values (toolbar Theme → Dark shows it live).
 */
export const SurfacesDark: Story = {
  name: "Surfaces dark",
  globals: { theme: "dark" },
  parameters: { layout: "padded" },
  render: () => (
    <div className="flex w-96 flex-col gap-2">
      <div data-surface="background" className="bg-background border border-foreground/10 p-2">background</div>
      <div data-surface="card" className="bg-card text-card-foreground p-2">card</div>
      <div data-surface="popover" className="bg-popover text-popover-foreground p-2">popover</div>
      <div data-surface="muted" className="bg-muted p-2">muted</div>
      <span data-surface="pill" className="rounded-full bg-foreground/5 px-1.5 py-px text-[10px]">foreground/5</span>
    </div>
  ),
  play: async () => {
    // The theme decorator toggled .dark on <html> for this story only.
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // The dark background is genuinely dark: the --background token flipped.
    const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
    const [r, g, b] = rgb;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    expect(luminance).toBeLessThan(0.5);
  },
};
