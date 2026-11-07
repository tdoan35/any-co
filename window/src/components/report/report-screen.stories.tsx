// Report screen stories (ANY-21 M6): the real route — ReportPage + reportLoader on
// /reports/:id — mounted in the harness memory router exactly as router.tsx declares it,
// inside the same pathless errorElement layout the production router uses, plus a stub
// /work/* for the crossing links.
//
// State → story inventory (the report screen's principal states):
//   populated report, provenance, linked loop
//                            → RecordedReport (play: the loader resolves the recorded 135M
//                              report; breadcrumbs, caveats, provenance and the Replay-the-
//                              loop link; the link lands on the loop's task URL)
//   dark theme               → RecordedReportDark (same route, `.dark` tokens)
//   unknown report id        → UnknownReportNotFound (the loader's 404 data surfaces the
//                              production RouteError inside the app layout)
//
//   The report body's conditional sections (no setup / not illustrative / no email note /
//   artifact download links) are component-level render states — they live in the
//   co-located report-view stories.
//
// The loader runs against the mock API (no server; the harness guard would block one).
// The recording fixture is the same bundle the mock API serves, so the screen is the
// production view, not a bespoke story build.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { RouteError } from "@/routes/error";
import { ReportPage, reportLoader } from "@/routes/report";

const VIEWPORTS = {
  wide: { name: "Wide · screen", styles: { width: "1600px", height: "1000px" } },
} as const;

const meta = {
  title: "Work/Report screen",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
    a11y: {
      // Scoped exception, token-level like every prior file: muted metas, crumbs and the
      // provenance labels sit below the 4.5:1 bar — the same design tokens the Weave /
      // work / studio cards scoped out. Every other rule errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Pathless errorElement layout, as in router.tsx, so a thrown 404 renders RouteError.
const routes = [
  {
    errorElement: <RouteError />,
    children: [
      { path: "/reports/:id", element: <ReportPage />, loader: reportLoader },
      { path: "/work/:taskId", element: <p data-testid="work-probe">task</p> },
    ],
  },
];

const reportScreen = (entry: string) => ({
  viewport: { defaultViewport: "wide", viewports: VIEWPORTS },
  router: { routes, initialEntries: [entry] },
});

// ---- populated: the recorded 135M report, provenance and the loop it came from ----

/** Direct-loaded report: the production view on the recorded loop's report id. */
export const RecordedReport: Story = {
  name: "Recorded report · provenance and loop link",
  parameters: reportScreen("/reports/report-ngram-1"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The loader resolved the recording: title, illustrative flag and intro.
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Does an n-gram lookup table improve a much smaller open model?" })).toBeInTheDocument());
    expect(canvas.getByText("Illustrative")).toBeInTheDocument();
    expect(canvas.getByText(/The Research Team produced this report/)).toBeInTheDocument();

    // Breadcrumbs name the loop's task and project, back to Work.
    expect(canvas.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/work");
    expect(canvas.getByRole("link", { name: "Engram on small models" })).toHaveAttribute("href", "/work?project=engram");
    expect(canvas.getByRole("link", { name: "n-gram fusion on a 135M model" })).toHaveAttribute("href", "/work/ngram-135m");

    // Setup, measured results (valid vs contaminated) and the caveats.
    expect(canvas.getByText("135M open model")).toBeInTheDocument();
    expect(canvas.getByText("Held-out; overlap removed after review")).toBeInTheDocument();
    const rows = within(canvas.getByText("Held-out perplexity").closest("section")!).getAllByRole("row");
    expect(rows).toHaveLength(4); // header + three configurations
    expect(canvas.getByText("34.2")).toBeInTheDocument();
    expect(canvas.getByText("−9.6%")).toBeInTheDocument();
    expect(canvas.getAllByText("valid")).toHaveLength(2);
    expect(canvas.getByText("contaminated")).toBeInTheDocument();
    expect(canvas.getByText("Inference-time fusion is a proxy; a trained-in Engram may behave differently.")).toBeInTheDocument();

    // Provenance is the report's receipt, and the loop link crosses to the task screen.
    expect(canvas.getByText("Loop 1 · recorded")).toBeInTheDocument();
    expect(canvas.getByText("Accepted after 1 rework")).toBeInTheDocument();
    const replay = canvas.getByRole("link", { name: "Replay the loop" });
    expect(replay).toHaveAttribute("href", "/work/ngram-135m");

    // Artifacts are named with their origin; the fixture's have no ids, so no links.
    expect(canvas.getByText("code-bundle.zip")).toBeInTheDocument();
    expect(canvas.getByText("Jonah · Sprite")).toBeInTheDocument();
    expect(canvas.queryByRole("link", { name: "code-bundle.zip" })).toBeNull();

    // Five personas made this; the delivery note is part of the record.
    expect(canvas.getAllByTitle(/ · /)).toHaveLength(5);
    expect(canvas.getByText(/Also emailed to you via AgentMail/)).toBeInTheDocument();

    // The loop link navigates the memory router to the task, not a dead href.
    const user = userEvent.setup();
    await user.click(replay);
    await waitFor(() => expect(storyRouter()!.state.location.pathname).toBe("/work/ngram-135m"));
  },
};

// ---- the same report under the dark theme ----

/** One implementation, two palettes: the route under the app's `.dark` tokens. */
export const RecordedReportDark: Story = {
  name: "Recorded report · dark theme",
  parameters: reportScreen("/reports/report-ngram-1"),
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Does an n-gram lookup table improve a much smaller open model?" })).toBeInTheDocument());
    // The theme decorator keyed the tokens off `.dark` on <html> for this story only.
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(canvas.getByText("Loop 1 · recorded")).toBeInTheDocument();
  },
};

// ---- unavailable: a report id the mock world does not know ----

/** Unknown id: the loader's 404 data renders the production RouteError. */
export const UnknownReportNotFound: Story = {
  name: "Unknown report · not found",
  parameters: reportScreen("/reports/report-unknown"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Page not found")).toBeInTheDocument());
    expect(canvas.getByRole("link", { name: "Back to Fabric" })).toHaveAttribute("href", "/");
    expect(storyRouter()!.state.location.pathname).toBe("/reports/report-unknown");
  },
};
