import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { AgentAvatar, InitialAvatar } from "./agent-avatar";
import { dana, jonah } from "@/lib/mock/assistant";

const meta = {
  title: "Components/AgentAvatar",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Sprite with only a still frame (no loops): the still shows alone. */
export const SpriteStill: Story = {
  name: "Sprite still",
  render: () => <AgentAvatar avatar={jonah.avatar!} name={jonah.name} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const avatar = canvas.getByRole("img", { name: "Jonah" });

    // The still portrait is referenced by the DOM and actually resolves to the asset.
    const still = avatar.querySelector("img");
    expect(still).not.toBeNull();
    expect((still as HTMLImageElement).src).toContain("/agents/jonah-happy.webp");
    await waitFor(() => expect((still as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
    expect(still!.classList.contains("hidden")).toBe(false);

    // Jonah has no loops, so the still is the only image — no strip can leak in.
    expect(avatar.querySelectorAll("img")).toHaveLength(1);
  },
};

/** Full sprite: idle loop by default, working loop while `working`. Both animate. */
export const WorkingSprite: Story = {
  name: "Working sprite",
  render: () => (
    <div className="flex items-end gap-6">
      <div className="flex flex-col items-center gap-2">
        <AgentAvatar avatar={dana.avatar!} name={dana.name} />
        <span className="text-xs text-muted-foreground">idle</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <AgentAvatar avatar={dana.avatar!} name={dana.name} working />
        <span className="text-xs text-muted-foreground">working</span>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const idleAvatar = canvas.getByRole("img", { name: "Dana" });
    const workingAvatar = canvas.getByRole("img", { name: "Dana, working" });

    // Both strips stay mounted in each avatar, but exactly one is visible per state.
    const idleIdle = idleAvatar.querySelector('img[src="/dana/happy-idle-strip.webp"]');
    const idleWorking = idleAvatar.querySelector('img[src="/dana/working-strip.webp"]');
    expect(idleIdle).not.toBeNull();
    expect(idleWorking).not.toBeNull();
    expect(idleIdle!.classList.contains("hidden")).toBe(false);
    expect(idleWorking!.classList.contains("hidden")).toBe(true);

    // Working state: the working loop is the visible one — never the idle strip.
    const workingIdle = workingAvatar.querySelector('img[src="/dana/happy-idle-strip.webp"]');
    const workingWorking = workingAvatar.querySelector('img[src="/dana/working-strip.webp"]');
    expect(workingIdle).not.toBeNull();
    expect(workingWorking).not.toBeNull();
    expect(workingIdle!.classList.contains("hidden")).toBe(true);
    expect(workingWorking!.classList.contains("hidden")).toBe(false);

    // And it is a real animated sprite strip (multi-frame, stepped), not a static frame.
    const workingStyle = (workingWorking as HTMLElement).style;
    expect(workingStyle.animation).toContain("sprite-strip");
    expect(workingStyle.getPropertyValue("--sprite-end")).not.toBe("");

    // The still sits underneath in both, so a slow strip never shows an empty frame.
    expect(idleAvatar.querySelector('img[src="/dana/happy-idle-still.webp"]')).not.toBeNull();
    expect(workingAvatar.querySelector('img[src="/dana/happy-idle-still.webp"]')).not.toBeNull();
  },
};

/** No art yet: a round initial in the agent's tone. */
export const InitialsFallback: Story = {
  name: "Initials fallback",
  render: () => <InitialAvatar initial={dana.name[0]} name={dana.name} tone={dana.tone} className="text-4xl" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const avatar = canvas.getByRole("img", { name: "Dana" });

    // The fallback is pure DOM: no portrait <img> that could fail to resolve.
    expect(avatar.querySelector("img")).toBeNull();

    // The initial renders as text in the agent's tone.
    const initial = avatar.querySelector("span");
    expect(initial).not.toBeNull();
    expect(initial!.textContent).toBe("D");
    expect(initial!.classList.contains("text-[2.6em]")).toBe(true);
    expect(avatar.classList.contains("bg-ok-soft")).toBe(true);
    expect(avatar.classList.contains("text-ok")).toBe(true);
  },
};
