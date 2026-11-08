// Studio projects stories: the sidebar's Projects section against fixture adapter data,
// with the gallery fetcher injected, so the mock-only story harness never touches the
// network; the pretend studios come from the storybook seam (lib/studio.ts
// setStudiosForStory). Repo names here are fixture-only, like packages/fixtures
// galleryRepos; live names always come from the adapters.
//  - One studio, two games (goal 4): both folders from one adapter, runs split by
//    run.game, studio-level runs under the studio's own folder, no studio tags.
//  - Two studios: one game each, tagged and switchable (the multi-studio path stays).

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

/** Fixture adapters: which game repo slugs each studio reports (goal 4: possibly several). */
const REPOS: Record<string, string[]> = {
  [S1.api]: ["demo-repo"],
  [S2.api]: ["other-demo"],
};
const bothFixture: GalleryFetcher = async (api) => ({ repos: REPOS[api] ?? [], entries: [] });
const twoGamesOneStudio: GalleryFetcher = async () => ({ repos: ["demo-repo", "other-demo"], entries: [] });
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

export const OneStudioTwoGames: Story = {
  name: "One studio, two games",
  parameters: { router: { routes: routes(<ProjectsPane config={[]} fetcher={twoGamesOneStudio} withWorkData />) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = canvas.getByTestId("probe");
    // No VITE_STUDIOS: one implicit studio, no switcher store underneath.
    expect(probe).toHaveAttribute("data-active", "none");

    // Both games from the one adapter, both active, each name exactly the title-cased
    // slug — an exact match proves there is no per-studio badge in the accessible name.
    expect(canvas.getByRole("button", { name: "Demo Repo" })).toHaveAttribute("data-active", "true");
    expect(canvas.getByRole("button", { name: "Other Demo" })).toHaveAttribute("data-active", "true");

    // Each game folder lists only its own runs (fixtures: two demo-repo, one other-demo,
    // one studio-level null). The null-game run goes under the studio's own folder, which
    // appears after the games — never inside a game folder.
    const runLinks = canvas.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/work/"));
    expect(runLinks).toHaveLength(4);
    expect(canvas.getAllByText("Is NAND fast enough to serve n-gram table lookups?")).toHaveLength(2);
    expect(canvas.getByRole("button", { name: "any-co" })).toHaveAttribute("data-active", "true");

    // Clicking a folder opens the Work board — no studio to switch.
    await userEvent.click(canvas.getByRole("button", { name: "Other Demo" }));
    await waitFor(() => expect(canvas.getByTestId("work-board")).toBeVisible());
  },
};

export const BothGamesOneActive: Story = {
  name: "Two studios: each game tagged and switchable",
  parameters: { router: { routes: routes(<ProjectsPane config={[S1, S2]} fetcher={bothFixture} withWorkData />) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = canvas.getByTestId("probe");
    expect(probe).toHaveAttribute("data-active", "s1");

    // Both games, derived (slugs title-cased) and tagged with their studio's label.
    expect(canvas.getByRole("button", { name: "Demo Repo Studio One" })).toHaveAttribute("data-active", "true");
    expect(canvas.getByRole("button", { name: "Other Demo Studio Two" })).toHaveAttribute("data-active", "false");

    // The active studio's game folder lists only its game's runs; its studio-level runs
    // (game null) sit under the studio's own folder. Nothing of Studio Two's is loaded.
    const runLinks = canvas.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/work/"));
    expect(runLinks.length).toBeGreaterThan(0);
    expect(canvas.queryByText("Switch to view")).toBeNull();

    // Clicking the other game switches studio through the same store the wordmark menu
    // drives (live, the remounting router then boots on the staged /work URL).
    await userEvent.click(canvas.getByRole("button", { name: "Other Demo Studio Two" }));
    await waitFor(() => expect(probe).toHaveAttribute("data-active", "s2"));

    // Studio One's folders are the inactive ones now: each open one offers "Switch to view".
    const switchButtons = canvas.getAllByRole("button", { name: "Switch to view" });
    expect(switchButtons.length).toBeGreaterThan(0);
    await userEvent.click(switchButtons[0]);
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
