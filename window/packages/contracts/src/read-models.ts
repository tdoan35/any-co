import { z } from "zod";

// Response checks for the two aggregate read models. The domain interfaces remain the
// authoritative TypeScript types; these schemas check the fields the UI reads at runtime.
const AgentSchema = z.object({
  id: z.string(), name: z.string(), role: z.string(), tone: z.string(),
  summary: z.string(), personality: z.string(), traits: z.array(z.string()),
  model: z.string(), contextTokens: z.number(), memory: z.array(z.object({ label: z.string(), value: z.string() })),
  tools: z.array(z.object({ name: z.string(), note: z.string(), policy: z.enum(["allowed", "approval", "blocked"]) })),
  greeting: z.string(), placeholder: z.string(),
});
const ProfileSchema = z.object({
  agent: AgentSchema, tagline: z.string(),
  workspace: z.object({
    files: z.array(z.object({ name: z.enum(["SOUL.md", "IDENTITY.md", "USER.md"]), body: z.string() })),
    skills: z.array(z.object({ name: z.string(), description: z.string() })),
    connectors: z.array(z.object({ name: z.string(), note: z.string(), status: z.enum(["connected", "available"]) })),
    memories: z.array(z.object({ text: z.string(), source: z.string(), when: z.string(), id: z.string().optional() })),
  }),
});
const TeamSchema = z.object({
  id: z.string(), name: z.string(), tagline: z.string(), purpose: z.string(),
  status: z.enum(["active", "idle"]), origin: z.string(),
  members: z.array(z.object({ agentId: z.string(), duty: z.string(), lead: z.boolean().optional() })),
  workflow: z.array(z.object({ label: z.string(), agentIds: z.array(z.string()), note: z.string(), gate: z.boolean().optional() })),
  reworkBudget: z.number(), criteria: z.array(z.string()),
});
export const RegistrySchema = z.object({
  agents: z.array(ProfileSchema), communityAgents: z.array(ProfileSchema),
  teams: z.array(TeamSchema), communityTeams: z.array(TeamSchema),
  organizations: z.array(z.object({
    id: z.string(), name: z.string(), headId: z.string(),
    slots: z.array(z.object({ key: z.string(), teamId: z.string() })),
    handoffs: z.array(z.object({ from: z.string(), to: z.string(), question: z.string(), preview: z.boolean().optional() })),
  })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), goal: z.string() })),
  sessions: z.array(z.object({ id: z.string(), title: z.string(), href: z.string(), agentId: z.string(), messages: z.number(), updated: z.string() })),
  personaPool: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), avatar: z.object({ still: z.string() }) })),
});

const ItemSchema = z.object({
  id: z.string(), kind: z.enum(["approval", "question", "escalation", "proposal", "finding", "result"]),
  agentId: z.string(), project: z.string(), title: z.string(), brief: z.string(), at: z.string(), why: z.string(),
  actions: z.array(z.object({ id: z.string(), label: z.string() })),
});
const PulseSchema = z.object({ id: z.string(), at: z.string(), kind: z.enum(["update", "event", "memory", "policy"]) });
export const WeaveSnapshotSchema = z.object({
  items: z.array(ItemSchema), pulse: z.array(PulseSchema),
  presence: z.array(z.object({ agentId: z.string(), state: z.enum(["working", "waiting", "blocked", "idle"]), activity: z.string(), since: z.string() })),
  calendar: z.array(z.object({ id: z.string(), title: z.string(), start: z.string(), end: z.string(), kind: z.enum(["meeting", "focus", "personal"]) })),
});
