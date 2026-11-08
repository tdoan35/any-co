import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/shell/app-shell";
import { useRegistry } from "@/lib/registry";
import { ExpandedCard } from "./agent-studio";
import { TeamsStudio } from "./teams-view";
import { InsetPanel, headerTitle } from "./studio-ui";

/**
 * Studio is one Teams chart. `?team=` opens a department, `?agent=` opens a person.
 * Opening a person from a team keeps `?team=` so Back returns there; opening one from
 * the chart does not. Legacy `?view=` links drop that param and land on the chart.
 */
export function StudioScreen() {
  const [params, setParams] = useSearchParams();
  const agentId = params.get("agent") ?? undefined;
  const teamId = params.get("team") ?? undefined;

  useEffect(() => {
    if (!params.get("view")) return;
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("view");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  const setSearch = (next: { agent?: string | null; team?: string | null }) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.delete("view");
    if (next.team === null) n.delete("team");
    else if (next.team) n.set("team", next.team);
    if (next.agent === null) n.delete("agent");
    else if (next.agent) n.set("agent", next.agent);
    return n;
  }, { replace: true });

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <span className={headerTitle}>Studio</span>
      </PageHeader>
      <InsetPanel pattern="grid">
        {agentId
          ? <AgentProfile agentId={agentId} onBack={() => setSearch({ agent: null })} />
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
