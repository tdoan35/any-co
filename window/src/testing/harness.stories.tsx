// ANY-8 M1 acceptance stories: they prove the harness contract, they are not UI demos.
//  - DirectNavigation / SequentialNavigation reach identical visible content via initial
//    history vs a click, and repeated runs are identical because WithHarness resets and
//    reseeds every module store before each story run.
//  - SearchParamsAndLoader navigates a loader route with search params — no
//    useLocation/useSearchParams context error.
//  - UnexpectedNetworkCall trips the mock-only guard with no server process anywhere.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Link, useLoaderData, useLocation, useSearchParams } from "react-router";
import { myProfiles } from "@fabric/fixtures/studio";
import { sessions as registrySessions } from "@fabric/fixtures/sessions";
import { WithHarness, storyRouter } from "../../.storybook/harness";
import { networkAttempts } from "../../.storybook/guard";
import { useRegistry } from "@/lib/registry";
import { mockScheduleSessions } from "@/lib/mock/schedule";

const meta = { title: "testing/Harness", decorators: [WithHarness] } satisfies Meta;
export default meta;

/** Polls until `probe` is true; play functions run after render, so navigation needs a beat. */
const waitFor = async (probe: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`harness play: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function LocationProbe() {
  const { pathname, search } = useLocation();
  return (
    <div>
      <p data-testid="probe-location">{`Location: ${pathname}${search}`}</p>
      <nav>
        <Link to="/inbox" data-testid="nav-inbox">Inbox</Link>
        <Link to="/archive" data-testid="nav-archive">Archive</Link>
      </nav>
    </div>
  );
}

const locationRoutes = [{ path: "*", element: <LocationProbe /> }];

/** Direct navigation: the story boots straight onto /inbox. */
export const DirectNavigation: StoryObj = {
  parameters: { router: { routes: locationRoutes, initialEntries: ["/inbox"] } },
  play: async ({ canvasElement }) => {
    const probe = () => canvasElement.querySelector("[data-testid=probe-location]")?.textContent;
    await waitFor(() => probe() === "Location: /inbox", "the /inbox probe");
  },
};

/** Sequential navigation: boots on /, clicks through — ending at the same content as DirectNavigation. */
export const SequentialNavigation: StoryObj = {
  parameters: { router: { routes: locationRoutes, initialEntries: ["/"] } },
  play: async ({ canvasElement }) => {
    const probe = () => canvasElement.querySelector("[data-testid=probe-location]")?.textContent;
    await waitFor(() => probe() === "Location: /", "the initial / probe");
    const link = canvasElement.querySelector<HTMLAnchorElement>("[data-testid=nav-inbox]");
    if (!link) throw new Error("harness play: nav-inbox link missing");
    link.click();
    await waitFor(() => probe() === "Location: /inbox", "navigation to /inbox");
  },
};

const boardLoader = async () => ({ label: "Work board" });

function LoaderProbe() {
  const data = useLoaderData<typeof boardLoader>();
  const [params] = useSearchParams();
  return <p data-testid="loader-probe">{`${data.label} · project=${params.get("project") ?? "none"}`}</p>;
}

/** Loader-dependent view + search params: navigated programmatically via the story router. */
export const SearchParamsAndLoader: StoryObj = {
  parameters: {
    router: {
      routes: [
        { path: "/work", element: <LoaderProbe />, loader: boardLoader },
        { path: "*", element: <p data-testid="nowhere">Not on the board</p> },
      ],
      initialEntries: ["/"],
    },
  },
  play: async ({ canvasElement }) => {
    const router = storyRouter();
    if (!router) throw new Error("harness play: no active story router");
    await router.navigate("/work?project=engram");
    const probe = () => canvasElement.querySelector("[data-testid=loader-probe]")?.textContent;
    await waitFor(() => probe() === "Work board · project=engram", "the loader + search-param probe");
  },
};

function RegistryProbe() {
  const registry = useRegistry();
  return <p data-testid="registry-probe">{`${registry.agents.length} agents · ${registry.sessions.length} sessions`}</p>;
}

/** The harness seeds registry/weave from the typed fixtures before each story run. */
export const SeededStores: StoryObj = {
  parameters: { router: { routes: [{ path: "*", element: <RegistryProbe /> }] } },
  play: async ({ canvasElement }) => {
    const expected = `${myProfiles.length} agents · ${registrySessions.length + mockScheduleSessions.length} sessions`;
    const probe = () => canvasElement.querySelector("[data-testid=registry-probe]")?.textContent;
    await waitFor(() => probe() === expected, `the seeded registry probe (${expected})`);
  },
};

function NetworkProbe() {
  const [error, setError] = useState("");
  const callServer = () => {
    try { void fetch("http://localhost:8787/api/registry"); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return (
    <div>
      <button type="button" data-testid="call-server" onClick={callServer}>Call server</button>
      {error && <p data-testid="guard-error" role="alert">{error}</p>}
    </div>
  );
}

/** An unexpected HTTP call is detected by the mock-only guard — no real server needed. */
export const UnexpectedNetworkCall: StoryObj = {
  render: () => <NetworkProbe />,
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector<HTMLButtonElement>("[data-testid=call-server]");
    if (!button) throw new Error("harness play: call-server button missing");
    button.click();
    const probe = () => canvasElement.querySelector("[data-testid=guard-error]")?.textContent ?? "";
    await waitFor(() => probe().includes("unexpected HTTP call blocked"), "the guard's visible failure");
    if (networkAttempts().length !== 1) {
      throw new Error(`harness play: expected 1 recorded network attempt, got ${networkAttempts().length}`);
    }
  },
};
