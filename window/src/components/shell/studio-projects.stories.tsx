// Studio projects stories: the sidebar's Projects section as links to each project's board,
// against fixture data. The active studio's projects are seeded into the registry store the
// way the root loader does live (one per game plus Studio); other studios' games come from
// an injected gallery fetcher, so the mock-only story harness never touches the network.
// The pretend studios come from the storybook seam (lib/studio.ts setStudiosForStory).
// Project names and repo slugs here are fixture-only; live names come from the adapters.
//  - One studio, two games (goal 4): a link per project, no tags, no gallery fetches.
//  - On a board: the row for the project on screen is the active one.
//  - Two studios: the other studio's game is tagged and switches studio on click.

import { useState } from "react";
import { Outlet, useLocation } from "react-router";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Project } from "@fabric/contracts";
import { WithHarness } from "../../../.storybook/harness";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setStudiosForStory, useStudio, type Studio } from "@/lib/studio";
import { setProjects } from "@/lib/registry";
import { StudioProjects } from "./studio-projects";
import type { GalleryFetcher } from "@/lib/studio-projects";

const S1 = { id: "s1", label: "Studio One", api: "http://127.0.0.1:8787" };
const S2 = { id: "s2", label: "Studio Two", api: "http://127.0.0.1:8790", readOnly: true };

/** The Work view's projects for the active studio, as board-view.ts builds them live. */
const PROJECTS: Project[] = [
  { id: "demo-repo", name: "Demo Repo", goal: "Studio-made game · games/demo-repo" },
  { id: "other-demo", name: "Other Demo", goal: "Studio-made game · games/other-demo" },
  { id: "studio", name: "Studio", goal: "Studio-level work." },
];

/** Fixture adapters: which game repo slugs each studio reports. */
const REPOS: Record<string, string[]> = { [S1.api]: ["demo-repo"], [S2.api]: ["far-game"] };
let fetched: string[] = [];
const fixtureFetcher: GalleryFetcher = async (api) => { fetched.push(api); return { repos: REPOS[api] ?? [], entries: [] }; };

/** The active studio and route, as data, so plays can assert the store and the navigation. */
function Probe() {
  const { studio } = useStudio();
  const { pathname, search } = useLocation();
  return <p data-testid="probe" data-active={studio?.id ?? "none"} data-path={pathname + search}>probe</p>;
}

/** Seeds the pretend world once per mount, before the section renders, then lays out sidebar + page. */
function ProjectsPane({ config, projects }: { config: Studio[]; projects: Project[] }) {
  useState(() => {
    fetched = [];
    setStudiosForStory(config);
    setProjects(projects);
  });
  return (
    <SidebarProvider>
      <TooltipProvider>
        <div className="w-72 rounded-lg border bg-sidebar p-2 text-sidebar-foreground">
          <SidebarMenu><StudioProjects fetchGallery={fixtureFetcher} /></SidebarMenu>
          <Probe />
          <Outlet />
        </div>
      </TooltipProvider>
    </SidebarProvider>
  );
}

const routes = (config: Studio[], projects: Project[] = PROJECTS) => [{
  element: <ProjectsPane config={config} projects={projects} />,
  children: [
    { path: "/", element: null },
    { path: "/work", element: <p data-testid="work-board">Work board</p> },
  ],
}];

const meta = {
  title: "Shell/StudioProjects",
  decorators: [WithHarness],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const OneStudioTwoGames: Story = {
  name: "One studio, two games: a link per project",
  parameters: { router: { routes: routes([]) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = canvas.getByTestId("probe");
    expect(probe).toHaveAttribute("data-active", "none");

    // One link per project straight to its board; exact names prove there is no studio tag.
    expect(canvas.getByRole("link", { name: "Demo Repo" })).toHaveAttribute("href", "/work?project=demo-repo");
    expect(canvas.getByRole("link", { name: "Other Demo" })).toHaveAttribute("href", "/work?project=other-demo");
    // Studio-level work is not a sidebar project (the nav's Studio item covers it); All projects reaches it.
    expect(canvas.queryByRole("link", { name: "Studio" })).toBeNull();
    expect(canvas.getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/work");
    // No folders: nothing expands, and no run list under the rows.
    expect(canvas.queryByRole("button", { name: /Expand|Collapse/ })).toBeNull();
    // The active studio's projects come from the store, so no gallery fetch at all.
    expect(fetched).toEqual([]);

    await userEvent.click(canvas.getByRole("link", { name: "Other Demo" }));
    await waitFor(() => expect(probe).toHaveAttribute("data-path", "/work?project=other-demo"));
    expect(canvas.getByTestId("work-board")).toBeVisible();
  },
};

export const ActiveOnItsBoard: Story = {
  name: "On a project's board: that row is active",
  parameters: { router: { routes: routes([]), initialEntries: ["/work?project=demo-repo"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("link", { name: "Demo Repo" })).toHaveAttribute("data-active", "true");
    expect(canvas.getByRole("link", { name: "Other Demo" })).toHaveAttribute("data-active", "false");
    expect(canvas.getByRole("link", { name: "All projects" })).toHaveAttribute("data-active", "false");

    await userEvent.click(canvas.getByRole("link", { name: "All projects" }));
    await waitFor(() => expect(canvas.getByRole("link", { name: "All projects" })).toHaveAttribute("data-active", "true"));
    expect(canvas.getByRole("link", { name: "Demo Repo" })).toHaveAttribute("data-active", "false");
  },
};

export const TwoStudios: Story = {
  name: "Two studios: the other studio's game is tagged and switches",
  parameters: { router: { routes: routes([S1, S2], PROJECTS.slice(0, 1)) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const probe = canvas.getByTestId("probe");
    expect(probe).toHaveAttribute("data-active", "s1");

    // The active studio's project, tagged; only the other studio's adapter is asked for games.
    expect(canvas.getByRole("link", { name: "Demo Repo Studio One" })).toHaveAttribute("href", "/work?project=demo-repo");
    const far = await canvas.findByRole("link", { name: "Far Game Studio Two" });
    expect(far).toHaveAttribute("href", "/work?project=far-game");
    expect(fetched).toEqual([S2.api]);

    // Clicking it switches studio through the same store the wordmark menu drives (live, the
    // remounting router then boots on the staged board URL).
    await userEvent.click(far);
    await waitFor(() => expect(probe).toHaveAttribute("data-active", "s2"));
  },
};
