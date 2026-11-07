// Seed profiles: the exact world each branch resets to.
// `demo` is the pre-approval state (SEED-1 clean); `lived-in` is today's mock world.
// Both derive from the same fixtures the web's mock mode reads, so lived-in matches the mock.
import type { ContextSnapshot, InboxItem, Organization, PersonaPoolEntry, Presence, Project, PulseEntry, Run, RunEvent, Schedule, ScheduleFire, Session, StudioProfile, StudioTeam, Task } from "@fabric/contracts";
import { communityProfiles, elliot, myProfiles, sana } from "../studio";
import { communityTeams, organizations, studioTeams } from "../teams";
import { projects, sessions } from "../sessions";
import { allSnapshots, runEventsById, runs, tasks } from "../work";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed } from "../weave";
import { scheduleFires, scheduleSessions, schedules as allSchedules } from "../schedules";

/** A loop the seed inserts as-is (the recorded 135M one comes from its bundle import instead). */
export interface SeededRun {
  run: Run;
  events: RunEvent[];
  snapshots: ContextSnapshot[];
}

export interface SeedWorld {
  profile: "demo" | "lived-in";
  agents: StudioProfile[];
  communityAgents: StudioProfile[];
  personaPool: PersonaPoolEntry[];
  teams: StudioTeam[];
  communityTeams: StudioTeam[];
  organizations: Organization[];
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  runs: SeededRun[];
  /** Recording bundle keys to import; `attach` optionally links the recording to an existing task. */
  recordings: { key: string; attachTaskId?: string }[];
  weave: { items: InboxItem[]; pulse: PulseEntry[]; presence: Presence[]; calendar: typeof calendarEvents };
  /** SCH: the seeded routines and their past fires. Demo keeps Dana's digest only (SEED-1: no Research Team). */
  schedules: Schedule[];
  scheduleFires: ScheduleFire[];
}

/** D3/CARD-8: approving the team and specialist authorizes the handoff — no approval of its own. */
const handoffWithoutApproval = (p: StudioProfile): StudioProfile =>
  p.agent.id === "dana"
    ? { ...p, agent: { ...p.agent, tools: p.agent.tools.map((t) => (t.name === "handoff_to_team" ? { ...t, policy: "allowed" as const } : t)) } }
    : p;

const personaEntry = (p: StudioProfile, role: string): PersonaPoolEntry => ({
  id: p.agent.id,
  name: p.agent.name,
  role,
  avatar: p.agent.avatar ?? { still: `/agents/${p.agent.id}-happy.webp` },
});

// ---- demo (pre-approval): nothing may mention the Research Team, its people or its work ----

const LEAK = /elliot|sana\b|research team/i;
/** Markers of the seeded tasks/loops (§4.8: demo seeds none of them). */
const TASK_REF = /135m|360m|nand|n-gram/i;

const pulseAgent = (e: PulseEntry) => (e.kind === "update" ? e.authorId : e.kind === "event" ? e.actorId : e.agentId);
const pulseText = (e: PulseEntry) =>
  e.kind === "update" ? `${e.title} ${e.body}` : e.kind === "event" ? e.text : e.kind === "memory" ? `${e.text} ${e.source}` : e.text;

/** IDENTITY.md lists only teams that exist here; a lone membership line disappears. */
const retagMembership = (p: StudioProfile, teamNames: Set<string>): StudioProfile => {
  const files = p.workspace.files.map((f) => {
    if (f.name !== "IDENTITY.md") return f;
    const match = f.body.match(/^Member of: (.*)$/m);
    if (!match) return f;
    const kept = match[1].split(", ").map((t) => t.replace(/\.$/, "")).filter((t) => teamNames.has(t));
    const body = kept.length
      ? f.body.replace(match[0], `Member of: ${kept.join(", ")}`)
      : f.body.replace(`${match[0]}\n`, "");
    return { ...f, body };
  });
  return { ...p, workspace: { ...p.workspace, files } };
};

/** Memories keep only the clauses that don't mention hidden personas or teams. */
const clampMemories = (p: StudioProfile): StudioProfile => {
  if (!p.workspace.memories.some((m) => LEAK.test(m.text))) return p;
  const memories = p.workspace.memories.map((m) => {
    const kept = m.text.split("; ").filter((clause) => !LEAK.test(clause)).join("; ");
    return kept ? { ...m, text: kept.charAt(0).toUpperCase() + kept.slice(1) } : m;
  });
  return { ...p, workspace: { ...p.workspace, memories } };
};

export function buildDemoWorld(): SeedWorld {
  const hidden = new Set(["elliot", "sana"]);
  const teams = studioTeams.filter((t) => t.id !== "research"); // Product Team only, idle
  const teamNames = new Set(teams.map((t) => t.name));
  const agents = myProfiles
    .filter((p) => !hidden.has(p.agent.id))
    .map((p) => clampMemories(retagMembership(handoffWithoutApproval(p), teamNames)));
  const agentIds = new Set(agents.map((p) => p.agent.id));
  // Members of teams absent from this world were doing that team's work; their presence leaks it.
  const absentTeamAgents = new Set(
    studioTeams.filter((t) => !teams.some((x) => x.id === t.id)).flatMap((t) => t.members.map((m) => m.agentId)),
  );
  const taskIds = new Set<string>(); // §4.8: demo seeds no tasks
  const items = inboxSeed.filter((i) => agentIds.has(i.agentId) && (!i.taskId || taskIds.has(i.taskId)));
  const itemIds = new Set(items.map((i) => i.id));
  return {
    profile: "demo",
    agents,
    communityAgents: communityProfiles,
    personaPool: [personaEntry(elliot, "Research Lead"), personaEntry(sana, "Validator")],
    teams,
    communityTeams,
    organizations: [
      {
        id: "ty-lab",
        name: "Ty's Lab",
        headId: "dana",
        slots: [{ key: "product-1", teamId: "product" }], // the Research slot and its edge appear once the team exists
        handoffs: [],
      },
    ],
    projects,
    sessions: [...sessions.filter((s) => s.id !== "p1" && s.id !== "s9"), scheduleSessions[0]], // no Elliot / Research Team threads; the digest thread is fine
    tasks: [], // §4.8: no tasks before approval
    runs: [],
    recordings: [{ key: "ngram-135m" }], // taskless: nothing behind it can play yet
    weave: {
      items,
      pulse: pulseSeed.filter(
        (e) => agentIds.has(pulseAgent(e)) && !absentTeamAgents.has(pulseAgent(e)) && !LEAK.test(pulseText(e)) && !TASK_REF.test(pulseText(e)),
      ),
      presence: presenceSeed.filter((p) => agentIds.has(p.agentId) && !absentTeamAgents.has(p.agentId) && (!p.itemId || itemIds.has(p.itemId))),
      calendar: calendarEvents.filter((e) => !LEAK.test(e.title) && !TASK_REF.test(e.title)),
    },
    schedules: allSchedules.slice(0, 1), // Dana's digest; the sweep and pulse would leak the Research Team
    scheduleFires: scheduleFires.filter((f) => f.scheduleId === "morning-digest"),
  };
}

export function buildLivedInWorld(): SeedWorld {
  const seededRuns: SeededRun[] = runs
    .filter((r) => r.id !== "run-ngram-1") // the 135M loop is imported from its bundle, attached to its task
    .map((run) => ({ run, events: runEventsById[run.id] ?? [], snapshots: allSnapshots.filter((s) => s.runId === run.id) }));
  return {
    profile: "lived-in",
    agents: myProfiles.map(handoffWithoutApproval),
    communityAgents: communityProfiles,
    personaPool: [],
    teams: studioTeams,
    communityTeams,
    organizations,
    projects,
    sessions: [...sessions, ...scheduleSessions],
    tasks,
    runs: seededRuns,
    recordings: [{ key: "ngram-135m", attachTaskId: "ngram-135m" }],
    weave: { items: inboxSeed, pulse: pulseSeed, presence: presenceSeed, calendar: calendarEvents },
    schedules: allSchedules,
    scheduleFires,
  };
}
