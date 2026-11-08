// Studio projects stories (sidebar brief): the Projects section with two studios
// configured — both games derived from fixture adapter data, one active. The gallery
// fetcher is injected, so the mock-only story harness never touches the network; the
// pretend studios come from the storybook seam (lib/studio.ts setStudiosForStory).
// Repo names here are fixture-only, like packages/fixtures galleryRepos; live names
// always come from the adapters.

import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithHarness } from "../../../.storybook/harness";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setStudiosForStory, useStudio, type Studio } from "@/lib/studio";
import { setWorkData } from "@/lib/registry";
import { runs as fixtureRuns, tasks as fixtureTasks } from "@fabric/fixtures/work";
import { StudioProjects } from "./studio-projects";
import type { GalleryFetcher } from "@/lib/studio-projects";

const S1 = { id: "s1", label: "Studio One", api: "http://127.0.0.1:8787" };
const S2 = { id: "s2", label: "Studio Two", api: "http://127.0.0.1:8790", readOnly: true };

/** Fixture adapters: each studio reports its own game repo slug. */
const REPOS: Record<string, string[]> = { [S1.api]: ["demo-repo"], [S2.api]: ["other-demo"] };
const bothFixture: GalleryFetcher = async (api) => ({ repos: REPOS[api] ?? [], entries: [] });
const singleFixture: GalleryFetcher = async () => ({ repos: ["demo-repo"], entries: [] });

/** The active studio and route, as data, so plays can assert the store and the navigation. */
function Probe() {
  const { studio } = useStudio();
  const { pathname } = useLocation();
  return <p data-testid="probe" data-active={studio?.id ?? "none"} data-path={pathname}>probe</p>;
}

/**
 * Seeds the pretend world once per mount, synchronously before the section renders (the
 * harness reset has already run by then). The router parameters carry this pane, so the
 * section mounts inside the memory router its rows navigate.
 */
function ProjectsPane({ config, fetcher, withWorkData }: { config: Studio[]; fetcher: GalleryFetcher; withWorkData?: boolean }) {
  useState(() => {
    setStudiosForStory(config);
    if (withWorkData) setWorkData([...fixtureTasks], [...fixtureRuns]);
  });
  return (
    <SidebarProvider>
      <TooltipProvider>
        <div className="w-72 rounded-lg border bg-sidebar p-2 text-sidebar-foreground">
          <StudioProjects fetchGallery={fetcher} />
          <Probe />
        </div>
      </TooltipProvider>
    </SidebarProvider>
  );
}

const routes = (pane: ReactNode) => [
  { path: "/", element: pane },
  { path: "/work", element: <p data-testid="work-board">Work board</p> },
];

const meta = {
  title: "Shell/StudioProjects",
  decorators: [WithHarness],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const BothGamesOneActive: Story = {
  name: "Both games, one active",
  parameters: { router: { routes: routes(<ProjectsPane config={[S1, S2]} fetcher={bothFixture} withWorkData />) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = canvas.getByTestId("probe");
    expect(probe).toHaveAttribute("data-active", "s1");

    // Both games, derived (slugs title-cased) and tagged with their studio's label.
    expect(canvas.getByRole("button", { name: "Demo Repo Studio One" })).toHaveAttribute("data-active", "true");
    expect(canvas.getByRole("button", { name: "Other Demo Studio Two" })).toHaveAttribute("data-active", "false");
    expect(canvas.getByText("Studio One")).toBeTruthy();
    expect(canvas.getByText("Studio Two")).toBeTruthy();

    // The active folder is open: its latest runs are listed, each linking to its task.
    // The inactive folder is closed — nothing of Studio Two's is loaded.
    const runLinks = canvas.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/work/"));
    expect(runLinks.length).toBeGreaterThan(0);
    expect(canvas.queryByText("Switch to view")).toBeNull();

    // Clicking the other game switches studio through the same store the wordmark menu
    // drives (live, the remounting router then boots on the staged /work URL).
    await userEvent.click(canvas.getByRole("button", { name: "Other Demo Studio Two" }));
    await waitFor(() => expect(probe).toHaveAttribute("data-active", "s2"));

    // Studio One is now the inactive one: its still-open folder offers "Switch to view".
    // The chevron alone owns expand/collapse — the row click stays on open-the-board.
    await userEvent.click(canvas.getByRole("button", { name: "Collapse Demo Repo" }));
    await waitFor(() => expect(canvas.queryByText("Switch to view")).toBeNull());
    await userEvent.click(canvas.getByRole("button", { name: "Expand Demo Repo" }));
    await userEvent.click(canvas.getByRole("button", { name: "Switch to view" }));
    await waitFor(() => expect(probe).toHaveAttribute("data-active", "s1"));

    // The active row opens the board outright, in-story and live alike.
    await userEvent.click(canvas.getByRole("button", { name: "Demo Repo Studio One" }));
    await waitFor(() => expect(canvas.getByTestId("work-board")).toBeVisible());
  },
};

export const SingleStudioGame: Story = {
  name: "Single studio: its one game, untagged",
  parameters: { router: { routes: routes(<ProjectsPane config={[]} fetcher={singleFixture} />) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // No VITE_STUDIOS: one folder for the single studio's game, derived the same way,
    // with no studio tag (there is only one) and no switcher store underneath.
    expect(canvas.getAllByRole("button", { name: "Demo Repo" })).toHaveLength(1);
    expect(canvas.queryByText("any-co")).toBeNull();
    // Clicking it just opens the Work board.
    await userEvent.click(canvas.getByRole("button", { name: "Demo Repo" }));
    await waitFor(() => expect(canvas.getByTestId("work-board")).toBeVisible());
  },
};
