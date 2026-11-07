// Report view stories (ANY-21 M6): the report body component on its own, for the
// conditional render states the single recorded fixture cannot reach through the route
// (the screen stories cover the populated route in light and dark).
//
// State → story inventory:
//   no setup, not illustrative, no email note, no loop link,
//   id-less artifacts           → WithoutOptionalSections (every conditional branch off)
//   artifacts with ids          → ArtifactDownloadLinks (stream URLs, new tab)
//
// The typed fixture is the recording bundle re-stamped exactly as the mock API does
// (lib/api/mock.ts) — no bespoke story data, no backend fetch.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { recordings } from "@fabric/fixtures/recordings";
import type { Report } from "@/lib/types";
import { ReportView } from "./report-view";

const meta = {
  title: "Work/Report view",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level like every prior file: muted metas and labels sit
      // below the 4.5:1 bar on the same design tokens. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Re-stamp the recording, mirroring lib/api/mock.ts — same ids the route loader yields.
const recorded: Report = { ...recordings["ngram-135m"].report, id: "report-ngram-1", runId: "run-ngram-1" };

/** A sparse report: no setup table, no illustrative flag, no email note, no loop link. */
export const WithoutOptionalSections: Story = {
  name: "Without optional sections",
  parameters: { router: { routes: [{ path: "/", element: <ReportViewBody /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Title and summary remain; every conditional section is gone.
    expect(canvas.getByRole("heading", { name: "Does an n-gram lookup table improve a much smaller open model?" })).toBeInTheDocument();
    expect(canvas.queryByText("Illustrative")).toBeNull();
    expect(canvas.queryByRole("heading", { name: "Setup" })).toBeNull();
    expect(canvas.queryByText(/Also emailed to you via AgentMail/)).toBeNull();
    expect(canvas.queryByRole("link", { name: "Replay the loop" })).toBeNull();

    // Id-less artifacts stay plain text, not links.
    expect(canvas.getByText("eval-log.jsonl")).toBeInTheDocument();
    expect(canvas.queryByRole("link", { name: "eval-log.jsonl" })).toBeNull();

    // Made-by portraits still resolve from the seeded registry.
    expect(canvas.getAllByTitle(/ · /)).toHaveLength(5);
  },
};

/** Artifacts carrying ids render as stream links, opened in a new tab. */
export const ArtifactDownloadLinks: Story = {
  name: "Artifact download links",
  parameters: { router: { routes: [{ path: "/", element: <ReportViewBody links /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole("link", { name: "eval-log.jsonl" });
    // streamUrl: the mock API base + /api, whatever env the storybook build carries.
    expect(link.getAttribute("href")).toContain("/api/artifacts/eval-log");
    expect(link).toHaveAttribute("target", "_blank");
    expect(canvas.getByRole("link", { name: "code-bundle.zip" }).getAttribute("href")).toContain("/api/artifacts/code-bundle");
  },
};

// The two fixtures, defined after the stories that reference them via the lazy bodies
// below (function declarations hoist; the sparse/artifact data must exist before render).

function ReportViewBody({ links = false }: { links?: boolean }) {
  const sparse: Report = {
    ...recorded,
    kind: undefined,
    setup: undefined,
    emailed: false,
    artifacts: links
      ? [
          { name: "eval-log.jsonl", from: "Sana", id: "eval-log-1" },
          { name: "code-bundle.zip", from: "Jonah · Sprite", id: "code-bundle-1" },
        ]
      : recorded.artifacts,
  };
  return (
    <div className="min-h-screen bg-background">
      <ReportView report={sparse} />
    </div>
  );
}
