import type { StudioTeam } from "@fabric/contracts";

// Work's existing lane/inspector layout takes a workflow owner. This is a view of
// Dana's direct execution, not a provisioned team or a specialist delegation.
export const danaErrandOwner: StudioTeam = {
  id: "dana", name: "Dana", tagline: "Direct browser errand", purpose: "Dana handles this errand directly",
  status: "active", origin: "Direct assistant errand",
  members: [{ agentId: "dana", duty: "Browser errand", lead: true }],
  workflow: [{ label: "browser", agentIds: ["dana"], note: "Bounded browser tool; only the compact result returns to Dana" }],
  reworkBudget: 0, criteria: ["Report only observed confirmation"],
};
