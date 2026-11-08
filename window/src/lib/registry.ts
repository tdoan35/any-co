import { useSyncExternalStore } from "react";
import { api, httpMode } from "@/lib/api";
import { withCastAvatars } from "@/lib/cast";
import type { ChatAgent, Organization, Project, Registry, Run, Session, StudioProfile, Task } from "@fabric/contracts";

const empty: Registry = { agents: [], communityAgents: [], teams: [], communityTeams: [], organizations: [], projects: [], sessions: [], personaPool: [] };
let current: Registry = empty;
let tasks: Task[] = [];
let runs: Run[] = [];
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export function useRegistry() { useSyncExternalStore(subscribe, () => version); return current; }
/** Agents the API sent without art get their cast portrait (lib/cast.ts). */
export function setRegistry(value: Registry) { current = withCastAvatars(value); notify(); }
export function setWorkData(nextTasks: Task[], nextRuns: Run[]) { tasks = nextTasks; runs = nextRuns; notify(); }
export function setProjects(projects: Project[]) { current = { ...current, projects }; notify(); }

/**
 * Restore the module-level store to its empty initial state: storybook harnesses do it so
 * every story run starts from the same world, and the studio switcher does it (via
 * rootLoader) so one studio's data never paints under another's label.
 */
export function resetRegistryStore() {
  current = empty;
  tasks = [];
  runs = [];
  notify();
}

export const registry = () => current;
export const profileById = (id: string): StudioProfile => [...current.agents, ...current.communityAgents].find((p) => p.agent.id === id)!;

/**
 * Keep/Forget on a Memory tab row: the store patches immediately, the API call is the caller's.
 * A reload refetches /registry, so the server's decision is what survives.
 */
export function patchMemory(agentId: string, memoryId: string, decision: "kept" | "forgotten") {
  const patch = (profiles: StudioProfile[]) => profiles.map((p) => {
    if (p.agent.id !== agentId) return p;
    const memories = decision === "forgotten"
      ? p.workspace.memories.filter((m) => m.id !== memoryId)
      : [...p.workspace.memories].sort((a, b) => (b.id === memoryId ? 1 : 0) - (a.id === memoryId ? 1 : 0));
    return { ...p, workspace: { ...p.workspace, memories } };
  });
  current = { ...current, agents: patch(current.agents), communityAgents: patch(current.communityAgents) };
  notify();
}

/** Forget from a Memory tab: optimistic patch, then the server decision (a failed call warns). */
export function forgetMemory(agentId: string, memoryId: string) {
  patchMemory(agentId, memoryId, "forgotten");
  void api.decideMemory(memoryId, "forgotten").catch((err: unknown) =>
    console.warn(`[registry] forget failed: ${err instanceof Error ? err.message : err}`));
}

export const myProfiles = () => current.agents;
export const communityProfiles = () => current.communityAgents;
export const studioTeams = () => current.teams;
export const communityTeams = () => current.communityTeams;
export const organizations = (): Organization[] => current.organizations;
export const projects = (): Project[] => current.projects;
export const sessions = (): Session[] => current.sessions;
/** Who you can chat with. Live: only the Studio Head (the org's head agent). Mock: Fabric's demo cast. */
export const chatAgents = (): ChatAgent[] => {
  if (httpMode) {
    const headId = current.organizations[0]?.headId;
    const head = headId ? current.agents.find((p) => p.agent.id === headId)?.agent : undefined;
    return head ? [head] : [];
  }
  return ["dana", "jonah", "megan", "carlos"].map((id) => current.agents.find((p) => p.agent.id === id)?.agent).filter((a): a is ChatAgent => !!a);
};
export const workTasks = () => tasks;
export const workRuns = () => runs;
