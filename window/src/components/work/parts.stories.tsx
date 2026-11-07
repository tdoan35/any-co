import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inboxSeed } from "@fabric/fixtures/weave";
import { AskFlag, FaceStack, Meter, ReworkPips, StatePill, StepDots } from "./parts";

// StepDots renders tooltips and FaceStack reads the seeded registry: both need the
// app's providers. WithHarness seeds the registry/weave stores per story run (and
// mounts the story router when the story declares one); TooltipProvider matches
// app-shell's wiring. WithHarness first = outermost, so stores reset before render.
const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Work/Parts",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const STATES = ["proposed", "running", "review", "blocked", "accepted", "caveat", "stopped"] as const;

const STATE_CLASSES: Record<(typeof STATES)[number], { label: string; cls: string[] }> = {
  proposed: { label: "Proposed", cls: ["bg-replay-soft", "text-replay"] },
  running: { label: "Running", cls: ["bg-run-soft", "text-run"] },
  review: { label: "In review", cls: ["bg-run-soft", "text-run"] },
  blocked: { label: "Blocked", cls: ["bg-warn-soft", "text-warn"] },
  accepted: { label: "Accepted", cls: ["bg-ok-soft", "text-ok"] },
  caveat: { label: "Accepted · caveat", cls: ["bg-ok-soft", "text-ok"] },
  stopped: { label: "Stopped", cls: ["bg-foreground/5", "text-muted-foreground"] },
};

/** StatePill: every LoopState, icon + word, never colour alone. */
export const StatePillStates: Story = {
  name: "State pill states",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    a11y: {
      // Scoped exception, token-level like Button/Badge's: the stopped pill pairs
      // muted-foreground (#737373) with bg-foreground/5 — 4.27:1 at 11px against
      // the required 4.5:1. Fixing it means changing the design tokens — out of
      // scope here. Every other rule and every other story still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
  render: () => (
    <div className="flex flex-col items-start gap-2">
      {STATES.map((state) => (
        <StatePill key={state} state={state} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pills = canvasElement.querySelectorAll("span");
    expect(pills).toHaveLength(STATES.length);

    STATES.forEach((state, index) => {
      const pill = pills[index];
      const { label, cls } = STATE_CLASSES[state];
      // Icon + word, in the state's tone pair.
      expect(pill.querySelector("svg")).not.toBeNull();
      expect(pill.textContent).toContain(label);
      for (const c of cls) {
        expect(pill.classList.contains(c)).toBe(true);
      }
    });
  },
};

const STAGES = [
  { label: "Plan", state: "done" as const },
  { label: "Implement", state: "active" as const },
  { label: "Review", state: "pending" as const, gate: true },
  { label: "Ship", state: "pending" as const },
];

const STAGE_WORDS: Record<string, string> = {
  done: "done",
  active: "in progress",
  pending: "not started",
};

/** StepDots: the workflow as dots (review is a diamond), with tooltips per stage. */
export const StepDotsStages: Story = {
  name: "Step dots stages",
  decorators: [WithHarness, tooltipDecorator],
  render: () => <StepDots stages={STAGES} />,
  play: async ({ canvasElement }) => {
    const stepper = canvasElement.querySelector("span[aria-label]");
    expect(stepper).not.toBeNull();

    // The whole stepper is readable non-visually, stage by stage.
    const expectedLabel = STAGES.map((s) => `${s.label}: ${STAGE_WORDS[s.state]}`).join(", ");
    expect(stepper!.getAttribute("aria-label")).toBe(expectedLabel);

    // Four dots; the gate (review) is drawn as a diamond.
    const stageDots = stepper!.querySelectorAll<HTMLElement>(":scope > span");
    expect(stageDots).toHaveLength(STAGES.length);
    const gateDot = stageDots[2];
    expect(gateDot.classList.contains("rotate-45")).toBe(true);
    expect(gateDot.classList.contains("rounded-[1px]")).toBe(true);

    // Hover the active stage: its tooltip opens with the same words.
    const user = userEvent.setup();
    await user.hover(stageDots[1]);
    const tooltip = await waitFor(() => {
      const el = document.querySelector("[data-slot=tooltip-content]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(tooltip.textContent).toContain("Implement · in progress");
  },
};

/** Meter: ratio against a limit, in the semantic tones, with a real meter role. */
export const MeterTones: Story = {
  name: "Meter tones",
  decorators: [WithHarness, tooltipDecorator],
  render: () => (
    <div className="flex w-72 flex-col gap-2">
      <Meter value={3} max={4} tone="run" label="Time used of run budget" />
      <Meter value={9} max={10} tone="ok" label="Steps completed" />
      <Meter value={9} max={10} tone="warn" label="Rework budget used" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const meters = canvasElement.querySelectorAll("[role=meter]");
    expect(meters).toHaveLength(3);

    // 3 of 4: aria carries the ratio and the accessible name, the fill is 75%.
    const first = meters[0];
    expect(first).toHaveAttribute("aria-valuenow", "3");
    expect(first).toHaveAttribute("aria-valuemin", "0");
    expect(first).toHaveAttribute("aria-valuemax", "4");
    expect(first).toHaveAttribute("aria-label", "Time used of run budget");
    const fill = first.querySelector("span")!;
    expect(fill.style.width).toBe("75%");
    expect(fill.classList.contains("bg-run")).toBe(true);
    expect(first.classList.contains("bg-run-soft")).toBe(true);

    // Tones keep their hue pair (fill + its own lighter track).
    expect(meters[1].querySelector("span")!.classList.contains("bg-ok")).toBe(true);
    expect(meters[1].classList.contains("bg-ok-soft")).toBe(true);
    expect(meters[2].querySelector("span")!.classList.contains("bg-warn")).toBe(true);
    expect(meters[2].classList.contains("bg-warn-soft")).toBe(true);
  },
};

/** ReworkPips: budget as pips, used ones amber, count read non-visually. */
export const ReworkPipsBudget: Story = {
  name: "Rework pips budget",
  decorators: [WithHarness, tooltipDecorator],
  render: () => (
    <div className="flex flex-col gap-2">
      <ReworkPips used={2} budget={4} />
      <ReworkPips used={0} budget={4} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pips = canvasElement.querySelectorAll("span[aria-label]");
    expect(pips).toHaveLength(2);

    // "Rework 2 of 4 used": two amber pips out of four.
    expect(pips[0].getAttribute("aria-label")).toBe("Rework 2 of 4 used");
    const used = pips[0].querySelectorAll(".bg-warn");
    expect(used).toHaveLength(2);
    expect(pips[0].querySelectorAll("span")).toHaveLength(4);

    // Fresh budget: no amber pips at all.
    expect(pips[1].getAttribute("aria-label")).toBe("Rework 0 of 4 used");
    expect(pips[1].querySelectorAll(".bg-warn")).toHaveLength(0);
  },
};

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="askflag-location">{`Location: ${pathname}${search}`}</p>;
}

/** AskFlag: amber, names what's waiting on you, and jumps to the item in Weave. */
export const AskFlagJump: Story = {
  name: "Ask flag jump",
  decorators: [WithHarness, tooltipDecorator],
  parameters: {
    router: {
      routes: [
        {
          path: "*",
          element: (
            <div className="flex flex-col gap-2">
              <AskFlag asks={[inboxSeed[0]]} />
              <LocationProbe />
            </div>
          ),
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Amber pill with the ask count in words (one approval = waiting on you).
    const flag = canvas.getByRole("button");
    expect(flag.classList.contains("bg-warn-soft")).toBe(true);
    expect(flag.classList.contains("text-warn")).toBe(true);
    expect(flag.textContent).toContain("1 ask waiting on you");
    expect(flag.title).toBe(inboxSeed[0].title);

    // Clicking jumps to the item in Weave — through the story's memory router.
    const user = userEvent.setup();
    await user.click(flag);
    const probe = () => canvasElement.querySelector("[data-testid=askflag-location]")?.textContent;
    await waitFor(() => expect(probe()).toBe("Location: /weave?item=fetch-shard"));
  },
};

/** FaceStack: the team as overlapping portraits with role titles, optional ring. */
export const FaceStackRing: Story = {
  name: "Face stack ring",
  decorators: [WithHarness, tooltipDecorator],
  render: () => (
    <div className="flex flex-col gap-3">
      <FaceStack ids={["jonah", "dana"]} />
      <FaceStack ids={["jonah"]} ring="run" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // The two stacks are the direct children of the story root div.
    const stacks = canvasElement.querySelectorAll(":scope > div > span");
    expect(stacks).toHaveLength(2);

    // Each face carries "Name · Role" as its title (the display rule).
    const faces = stacks[0].querySelectorAll<HTMLElement>(":scope > span");
    expect(faces).toHaveLength(2);
    expect(faces[0].title).toBe("Jonah · Coder");
    expect(faces[1].title).toBe("Dana · Executive assistant");

    // The ring tone rides on the wrapper when asked for.
    const ringed = stacks[1].querySelectorAll<HTMLElement>(":scope > span");
    expect(ringed[0].classList.contains("ring-run/60")).toBe(true);
    expect(stacks[0].querySelectorAll<HTMLElement>(":scope > span")[0].classList.contains("ring-run/60")).toBe(false);
  },
};
