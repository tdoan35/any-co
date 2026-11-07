// Story fixture helpers (ANY-8 M1): seed the registry/weave stores from the typed
// @fabric/fixtures world and reset every module-level seam between stories. Imported only
// by the storybook harness (.storybook/harness.tsx) — never from production code.
import { myProfiles, communityProfiles } from "@fabric/fixtures/studio";
import { studioTeams, communityTeams, organizations } from "@fabric/fixtures/teams";
import { sessions } from "@fabric/fixtures/sessions";
import { inboxSeed, pulseSeed, presenceSeed, calendarEvents, WEAVE_NOW } from "@fabric/fixtures/weave";
import { projects } from "@/lib/mock/sessions";
import { mockScheduleSessions } from "@/lib/mock/schedule";
import { resetRegistryStore, setRegistry } from "@/lib/registry";
import { pinMockNow, resetWeaveStore, setWeaveSnapshot } from "@/lib/weave-store";
import { resetMockData } from "@/lib/api/mock";
import type { Registry, WeaveSnapshot } from "@fabric/contracts";

/**
 * The seeded world stories see — mirrors the mock API's registry, built from the same
 * fixtures. Arrays are copied so a story mutating the store never rewrites fixture data.
 */
export const storyRegistry = (): Registry => ({
  agents: myProfiles,
  communityAgents: communityProfiles,
  teams: studioTeams,
  communityTeams,
  organizations,
  projects: [...projects],
  sessions: [...sessions, ...mockScheduleSessions],
  personaPool: [],
});

export const storyWeave = (): WeaveSnapshot => ({
  items: [...inboxSeed],
  pulse: [...pulseSeed],
  presence: [...presenceSeed],
  calendar: [...calendarEvents],
});

/**
 * Reset every module-level store, then seed it from the fixtures. The mock clock is pinned
 * to WEAVE_NOW so repeated runs are identical; a story wanting another instant re-pins via
 * `pinMockNow` from "@/lib/weave-store".
 */
export function resetAndSeedStores() {
  resetRegistryStore();
  resetWeaveStore();
  resetMockData();
  pinMockNow(WEAVE_NOW.toISOString());
  setRegistry(storyRegistry());
  setWeaveSnapshot(storyWeave());
}
