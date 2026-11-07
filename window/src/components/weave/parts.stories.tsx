// Weave parts stories (ANY-15 M4): the shared Weave pieces — persona faces with kind
// glyphs, the Name · Role display rule, project/run/artifact chips, health pills and
// the column chrome.
//
// Kind → glyph inventory (all six user-visible kinds; none excluded):
//   approval → ShieldCheck (warn) · question → MessageCircleQuestion (run) ·
//   escalation → LifeBuoy (warn) · proposal → Sparkles (replay) ·
//   finding → Telescope (run) · result → FileText (ok)
//
// Faces read the seeded registry (WithHarness), the RunChip navigates through the
// story's memory router; every story runs against resettable fixture data.

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ItemKind } from "@/lib/mock/weave";
import { KIND, ArtifactChip, ColumnHeader, ColumnLabel, Face, HealthPill, NameRole, ProjectChip, RunChip } from "./parts";

const tooltipDecorator: Decorator = (Story) => (
  <TooltipProvider>
    <Story />
  </TooltipProvider>
);

const meta = {
  title: "Weave/Parts",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const KIND_KINDS = Object.keys(KIND) as ItemKind[];

const KIND_TONES: Record<ItemKind, string> = {
  approval: "text-warn",
  question: "text-run",
  escalation: "text-warn",
  proposal: "text-replay",
  finding: "text-run",
  result: "text-ok",
};

/** Face + KIND: every inbox kind carries its glyph on the portrait edge, in its tone. */
export const KindGlyphs: Story = {
  name: "Kind glyphs",
  decorators: [WithHarness, tooltipDecorator],
  render: () => (
    <div className="flex items-start gap-3">
      {KIND_KINDS.map((k) => (
        <Face key={k} id="jonah" kind={k} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const glyphs = canvasElement.querySelectorAll<HTMLElement>("span[title]");
    expect(glyphs).toHaveLength(KIND_KINDS.length);

    KIND_KINDS.forEach((k, index) => {
      const glyph = glyphs[index];
      // The glyph names the kind non-visually and keeps the kind's tone.
      expect(glyph.title).toBe(KIND[k].label);
      expect(glyph.querySelector("svg")!.classList.contains(KIND_TONES[k])).toBe(true);
    });
  },
};

/** NameRole: the "Name · Role" display rule from the registry, with Ty's own handle. */
export const NameRoleDisplay: Story = {
  name: "Name · role display",
  decorators: [WithHarness],
  render: () => (
    <div className="flex flex-col gap-2 text-xs">
      <NameRole id="jonah" />
      <NameRole id="dana" />
      <NameRole id="you" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const roles = canvasElement.querySelectorAll(":scope > div > span");
    expect(roles).toHaveLength(3);
    expect(roles[0].textContent).toBe("Jonah · Coder");
    expect(roles[1].textContent).toBe("Dana · Executive assistant");
    // "you" is Ty: no registry lookup, no role suffix.
    expect(roles[2].textContent).toBe("You");
  },
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <p data-testid="chip-location">{`Location: ${pathname}`}</p>;
}

/** Chips: project and artifact chips are static; the run chip is a link into the loop. */
export const Chips: Story = {
  name: "Chips",
  decorators: [WithHarness],
  parameters: {
    router: {
      routes: [
        {
          path: "*",
          element: (
            <div className="flex flex-col items-start gap-2">
              <ProjectChip name="Engram on small models" />
              <RunChip run={{ label: "n-gram fusion at 360M", href: "/work/ngram-360m" }} />
              <ArtifactChip name="survey.md" />
              <LocationProbe />
            </div>
          ),
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    expect(canvas.getByText("Engram on small models")).toBeInTheDocument();
    expect(canvas.getByText("survey.md")).toBeInTheDocument();

    // The run chip navigates to the loop it belongs to.
    const runChip = canvas.getByRole("link", { name: "n-gram fusion at 360M" });
    expect(runChip).toHaveAttribute("href", "/work/ngram-360m");
    await user.click(runChip);
    await waitFor(() => expect(canvas.getByTestId("chip-location")).toHaveTextContent("Location: /work/ngram-360m"));
  },
};

/** HealthPill: every loop health, icon + word, never colour alone. */
export const HealthPillStates: Story = {
  name: "Health pill states",
  decorators: [WithHarness],
  render: () => (
    <div className="flex flex-col items-start gap-2">
      <HealthPill health="on_track" />
      <HealthPill health="at_risk" />
      <HealthPill health="done" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pills = canvasElement.querySelectorAll(":scope > div > span");
    expect(pills).toHaveLength(3);

    const EXPECTED = [
      { label: "On track", cls: ["bg-ok-soft", "text-ok"], icon: false },
      { label: "At risk", cls: ["bg-warn-soft", "text-warn"], icon: false },
      { label: "Done", cls: ["bg-ok-soft", "text-ok"], icon: true },
    ] as const;
    EXPECTED.forEach((expected, index) => {
      const pill = pills[index];
      expect(pill.textContent).toContain(expected.label);
      for (const c of expected.cls) expect(pill.classList.contains(c)).toBe(true);
      // Only "done" gets the check icon; the live states get a status dot.
      expect(!!pill.querySelector("svg")).toBe(expected.icon);
      expect(!!pill.querySelector(".bg-current")).toBe(!expected.icon);
    });
  },
};

/** Column chrome: the shared title row and the count-bearing section label. */
export const ColumnChrome: Story = {
  name: "Column chrome",
  decorators: [WithHarness],
  render: () => (
    <div className="w-80 rounded-xl border border-foreground/10">
      <ColumnHeader>
        <h2 className="text-sm font-semibold">Inbox</h2>
        <span className="text-xs tabular-nums text-muted-foreground">7 open</span>
      </ColumnHeader>
      <div className="p-2">
        <ColumnLabel count={4} right={<span className="tabular-nums">12 min</span>}>Needs you</ColumnLabel>
        <ColumnLabel count={0}>For you</ColumnLabel>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The header is the shared h-11 row every Weave column aligns to.
    const header = canvasElement.querySelector(":scope > div > div")!;
    expect(header.classList.contains("h-11")).toBe(true);
    expect(header.classList.contains("border-b")).toBe(true);
    expect(canvas.getByText("Inbox")).toBeInTheDocument();
    expect(canvas.getByText("7 open")).toBeInTheDocument();

    // Section labels carry their count, and can host a right-aligned extra.
    const labels = canvasElement.querySelectorAll(".text-xs.font-medium");
    expect(labels[0].textContent).toContain("Needs you");
    expect(labels[0].textContent).toContain("· 4");
    expect(labels[0].textContent).toContain("12 min");
    expect(labels[1].textContent).toContain("For you");
    expect(labels[1].textContent).toContain("· 0");
  },
};
