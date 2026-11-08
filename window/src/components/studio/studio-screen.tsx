import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/shell/app-shell";
import { useRegistry } from "@/lib/registry";
import { ExpandedCard } from "./agent-studio";
import { FlowView } from "./flow-view";
import { TeamsStudio } from "./teams-view";
import { InsetPanel, Segmented, headerTitle } from "./studio-ui";

const VIEWS = [{ value: "teams", label: "Teams" }, { value: "flow", label: "Flow" }] as const;
type StudioView = (typeof VIEWS)[number]["value"];

/**
 * Studio has two tabs. Teams is the org chart: `?team=` opens a department, `?agent=` a person.
 * Opening a person from a team keeps `?team=` so Back returns there. Flow (`?view=flow`) is the
 * work order, and opening a person from it keeps the tab. Any other `?view=` lands on Teams.
 */
export function StudioScreen() {
  const [params, setParams] = useSearchParams();
  const agentId = params.get("agent") ?? undefined;
  const teamId = params.get("team") ?? undefined;
  const view: StudioView = params.get("view") === "flow" ? "flow" : "teams";

  useEffect(() => {
    const current = params.get("view");
    if (!current || current === "flow") return;
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("view");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  const setSearch = (next: { agent?: string | null; team?: string | null; view?: StudioView | null }) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (next.view === null) n.delete("view");
    else if (next.view) n.set("view", next.view);
    if (next.team === null) n.delete("team");
    else if (next.team) n.set("team", next.team);
    if (next.agent === null) n.delete("agent");
    else if (next.agent) n.set("agent", next.agent);
    return n;
  }, { replace: true });

  return (
    <div className="flex h-full flex-col">
      <PageHeader center={
        <Segmented
          value={view}
          options={VIEWS}
          onChange={(v) => setSearch({ view: v === "flow" ? "flow" : null, agent: null, team: null })}
        />
      }>
        <span className={headerTitle}>Agents</span>
      </PageHeader>
      <InsetPanel pattern="grid">
        {agentId
          ? <AgentProfile agentId={agentId} onBack={() => setSearch({ agent: null })} />
          : view === "flow"
            ? <FlowView onOpenAgent={(id) => setSearch({ agent: id, team: null })} />
            : (
              <TeamsStudio
                teamId={teamId}
                onOpenTeam={(id) => setSearch({ team: id, agent: null })}
                onOpenAgent={(id) => setSearch({ agent: id, team: null })}
                onOpenMember={(id) => setSearch({ agent: id })}
                onBack={() => setSearch({ team: null })}
              />
            )}
      </InsetPanel>
    </div>
  );
}

function AgentProfile({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const registry = useRegistry();
  const profile = [...registry.agents, ...registry.communityAgents].find((p) => p.agent.id === agentId);
  if (!profile) return <p className="px-6 py-8 text-sm text-muted-foreground">No agent named {agentId}.</p>;
  return <ExpandedCard profile={profile} onClose={onBack} />;
}
