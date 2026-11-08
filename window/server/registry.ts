// Builds the Registry (agents, teams, organization) from the agent specs in agents/.
// The specs are the source of truth; nothing here is invented beyond layout defaults.
import type { Organization, Project, Registry, Session, StudioProfile, StudioTeam } from "@fabric/contracts";
import type { AgentSpec } from "../../runner/spec.ts";
import { STUDIO_PROJECT_ID, teamIdOf } from "./runs.ts";

const TONES = ["bg-ok-soft text-ok", "bg-run-soft text-run", "bg-warn-soft text-warn"];
const DEPT_ORDER = ["head", "greenlight", "design", "art", "audio", "eng", "qa", "marketing", "ops", "test"];
export const titleCase = (s: string) => s.split(/[-_]/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
/** Chart and role labels. Spec `dept` ids stay as they are. */
const DEPT_LABEL: Record<string, string> = {
  head: "Studio Head",
  greenlight: "Concept",
  design: "Game Design",
  art: "Art",
  audio: "Audio",
  eng: "Engineering",
  qa: "QA",
  marketing: "Marketing",
  ops: "Operations",
};
const deptLabel = (dept: string) => DEPT_LABEL[dept] ?? titleCase(dept);
const POLICY = { allow: "allowed", ask: "approval", deny: "blocked" } as const;

export const PROJECT: Project = { id: STUDIO_PROJECT_ID, name: "Studio", goal: "Run the autonomous studio." };

export function profileOf(spec: AgentSpec): StudioProfile {
  const tone = TONES[DEPT_ORDER.indexOf(spec.dept) % TONES.length] ?? TONES[0];
  return {
    agent: {
      id: spec.name,
      name: titleCase(spec.name),
      role: deptLabel(spec.dept),
      tone,
      summary: spec.description,
      personality: "",
      traits: [deptLabel(spec.dept), `runs ${spec.runner}`, `$${spec.budget.max_task_usd}/task`],
      model: spec.model,
      contextTokens: Math.round(spec.system.length / 4),
      memory: [],
      tools: Object.entries(spec.tools).map(([name, perm]) => ({ name, note: "", policy: POLICY[perm ?? "deny"] })),
      greeting: spec.dept === "head" ? "What would you like to know about the studio?" : "",
      placeholder: spec.dept === "head" ? `Ask ${titleCase(spec.name)}…` : "",
      // Chat chips for the head: plain status questions the Studio Head can answer from its tools.
      ...(spec.dept === "head"
        ? { suggestions: [
            { label: "What is the studio doing right now?", prompt: "What is the studio doing right now?" },
            { label: "What did each agent produce?", prompt: "Summarize what each agent has produced so far, with run ids." },
            { label: "How much have we spent?", prompt: "How much have we spent so far, and which agents account for it?" },
          ] }
        : {}),
    },
    tagline: spec.description,
    workspace: {
      files: [{ name: "SOUL.md", body: spec.system }],
      skills: spec.skills.map((name) => ({ name, description: "" })),
      connectors: [],
      memories: [],
    },
    status: "active",
  };
}

export function buildRegistry(specs: AgentSpec[], busy: ReadonlySet<string>, sessions: Session[] = []): Registry {
  const byDept = new Map<string, AgentSpec[]>();
  for (const s of specs) byDept.set(s.dept, [...(byDept.get(s.dept) ?? []), s]);
  const depts = [...byDept.keys()].sort((a, b) => DEPT_ORDER.indexOf(a) - DEPT_ORDER.indexOf(b));

  const teams: StudioTeam[] = depts.map((dept) => {
    const members = byDept.get(dept)!;
    return {
      id: teamIdOf(dept),
      name: deptLabel(dept),
      tagline: `${members.length} agent${members.length === 1 ? "" : "s"}`,
      purpose: members.map((m) => m.description).join(" "),
      status: members.some((m) => busy.has(m.name)) ? "active" : "idle",
      origin: "agents/",
      // Specs have no "lead" concept, so no one is crowned; only the Studio Head (dept "head") leads.
      members: members.map((m) => ({ agentId: m.name, duty: m.description, ...(dept === "head" ? { lead: true } : {}) })),
      workflow: [{ label: "Work", agentIds: members.map((m) => m.name), note: "" }],
      reworkBudget: 0,
      criteria: [],
    };
  });

  // The Studio Head tops the chart once a `head` spec exists. Until then headId is "" and the UI
  // shows a placeholder: no other agent stands in. A team made only of the head isn't drawn twice.
  const head = specs.find((s) => s.dept === "head");
  // The head is not drawn twice. `test` is the harness toy, not a studio department: one line under the chart opens it.
  const drawn = teams.filter((t) => {
    if (t.id === teamIdOf("test")) return false;
    return !(head && t.members.length === 1 && t.members[0].agentId === head.name);
  });
  const organizations: Organization[] = specs.length
    ? [{ id: "studio", name: "Studio", headId: head?.name ?? "", slots: drawn.map((t) => ({ key: t.id, teamId: t.id })), handoffs: [] }]
    : [];

  return {
    agents: specs.map(profileOf),
    communityAgents: [],
    teams,
    communityTeams: [],
    organizations,
    projects: [PROJECT],
    sessions,
    personaPool: [],
  };
}
