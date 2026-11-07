// The scripted demo conversation's data: the idea, both proposal cards and the handoff. One source for both modes: Dana's server-side fixture mode (DANA) builds its cards from
// these choices, and the web mock adapter streams these payloads as-is, so offline mode shows the
// same cards as the live demo. The enriched fields (CARD-1, D1) are exactly what the server's
// teamCard/specialistCard produce on the demo seed — packages/agents' cards.test pins that.
import type { HandoffPayload, ProposalRow, SpecialistProposal, TeamProposal } from "@fabric/contracts";

export const IDEA_PROMPT =
  "I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM.";

/** The new Research Lead's defaults, as the demo script shows them (CARD-1). The server appends the rework row. */
export const LEAD_DEFAULTS: ProposalRow[] = [
  { label: "Tools", value: "artifacts.read · workspace.write · team.assign", why: "Plans and assigns the work; doesn't run code himself" },
  { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
  { label: "Model", value: "Sonnet 5.5", why: "Planning-heavy work at moderate length" },
];

/** The lead-defaults row that follows the team's rework budget. */
export const reworkBudgetRow = (budget: number): ProposalRow => ({
  label: "Rework budget", value: `${budget} bounces, then it escalates to you`, why: "Bounded autonomy: exhaustion blocks, it never loops",
});

export const teamProposal: TeamProposal = {
  kind: "team",
  proposalId: "prop-scripted-team",
  name: "Research Team",
  purpose: "Investigates ideas end to end: survey, implementation, independent validation and review.",
  roster: [
    { agentId: "elliot", name: "Elliot", role: "Research Lead", status: "new", avatar: "/agents/elliot-happy.webp" },
    { agentId: "megan", name: "Megan", role: "Investigator", status: "existing", avatar: "/agents/megan-happy.webp" },
    { agentId: "jonah", name: "Jonah", role: "Coder", status: "existing", avatar: "/agents/jonah-happy.webp" },
    { agentId: "carlos", name: "Carlos", role: "Reviewer", status: "existing", avatar: "/agents/carlos-happy.webp" },
  ],
  workflow: [
    { label: "Plan", agentIds: ["elliot"] },
    { label: "Prepare", agentIds: ["megan", "jonah", "sana"] },
    { label: "Synthesize", agentIds: ["elliot"] },
    { label: "Implement", agentIds: ["jonah"] },
    { label: "Validate", agentIds: ["sana"] },
    { label: "Review", agentIds: ["carlos"], gate: true },
  ],
  reworkBudget: 2,
  criteria: [
    "Baseline and fused model evaluated on the same split",
    "Held-out split never seen by the n-gram table",
    "Sana reproduces the headline number",
    "Report states caveats and what would change the verdict",
  ],
  leadDefaults: [...LEAD_DEFAULTS, reworkBudgetRow(2)],
};

export const specialistProposal: SpecialistProposal = {
  kind: "specialist",
  proposalId: "prop-scripted-specialist",
  name: "Validator",
  purpose: "Independently checks the experiment's results against a held-out split.",
  persona: { id: "sana", name: "Sana", role: "Validator", avatar: "/agents/sana-happy.webp" },
  rows: [
    { label: "Tools", value: "Read artifacts · run checks in an isolated Sprite", why: "Needs to execute evaluations, nothing else" },
    { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
    { label: "Restriction", value: "Cannot edit acceptance criteria", why: "Keeps the review independent" },
    { label: "Lifecycle", value: "This team · save as reusable agent", why: "Reuse beats creating again" },
  ],
};

/** The scripted handoff. Mock mode links to the recorded loop's task; the server returns the real ids. */
export const handoff: HandoffPayload = {
  runId: "run-ngram-1",
  taskId: "ngram-135m",
  teamName: "Research Team",
  summary: "Brief compiled from your request and the team definition — not your chat transcript.",
  members: [
    { agentId: "elliot", name: "Elliot", role: "Research Lead", state: "planning" },
    { agentId: "megan", name: "Megan", role: "Investigator", state: "searching" },
    { agentId: "jonah", name: "Jonah", role: "Coder", state: "setting up" },
    { agentId: "sana", name: "Sana", role: "Validator", state: "preparing checks" },
  ],
};
