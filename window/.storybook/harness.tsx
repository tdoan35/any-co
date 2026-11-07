// The story harness (ANY-8 M1): per-story reset + fixture seeding, forced mock-only
// networking, and a controlled memory data-router when a story declares routes.
//
// `WithHarness` is opt-in — imported into a story file's `decorators`, never wired
// globally in preview.tsx — so no story accidentally mounts the production root loader.

import { useRef, useState } from "react";
import type { Decorator } from "@storybook/react-vite";
import type { RouteObject } from "react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { resetAndSeedStores } from "@/testing/seed";
import { installNetworkGuard, resetNetworkGuard } from "./guard";

/** Per-story router wiring, declared on `parameters.router`. */
export interface RouterHarness {
  /** Memory-router route tree: gives Link/useLocation/useSearchParams/loader views context. */
  routes: RouteObject[];
  /** Initial history entries; defaults to ["/"]. */
  initialEntries?: string[];
}

type MemoryRouter = ReturnType<typeof createMemoryRouter>;

let preparedFor: string | undefined;
let active: MemoryRouter | undefined;

const resetWorld = () => {
  resetAndSeedStores();
  installNetworkGuard();
  resetNetworkGuard();
};

/** The active story's memory router — play functions navigate through it programmatically. */
export const storyRouter = (): MemoryRouter | undefined => active;

export const WithHarness: Decorator = (Story, context) => {
  const routerRef = useRef<MemoryRouter | undefined>(undefined);
  // Reset exactly once per mount, synchronously before children render. A re-render of the
  // same story — e.g. after a play-driven navigation — must not wipe state mid-assertion.
  useState(() => { resetWorld(); });
  // ...and this covers a story switch that reuses the mounted decorator instance.
  if (preparedFor !== context.id) {
    resetWorld();
    routerRef.current = undefined;
    preparedFor = context.id;
  }
  const param = (context.parameters as { router?: RouterHarness } | undefined)?.router;
  if (!param) {
    active = undefined;
    return <Story />;
  }
  if (!routerRef.current) {
    routerRef.current = createMemoryRouter(param.routes, { initialEntries: param.initialEntries ?? ["/"] });
  }
  active = routerRef.current;
  return <RouterProvider router={routerRef.current} />;
};
