import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "@/components/shell/app-shell";
import { useRegistry } from "@/lib/registry";
import { AgentProfilePanel, type SideTab } from "@/components/chat/assistant-hero";
import { agentOf } from "@/components/weave/parts";
import { ExpandedCard } from "./agent-studio";
import { FlowView } from "./flow-view";
import { TeamsStudio } from "./teams-view";
import { InsetPanel, Segmented, headerTitle } from "./studio-ui";

const VIEWS = [{ value: "teams", label: "Teams" }, { value: "flow", label: "Flow" }] as const;
type StudioView = (typeof VIEWS)[number]["value"];

/**
 * Studio has two tabs. Teams is the org chart: `?team=` opens a department, `?agent=` a person.
 * Opening a person from a team keeps `?team=` so Back returns there. Flow (`?view=flow`) is how the
 * studio works; `?agent=` there opens the person in the right-hand panel beside the chart. Any other
 * `?view=` lands on Teams.
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

  // Flow keeps the chart in view: a person opens in the right-hand panel (as in a New Thread),
  // docked inside the grid container; the chart narrows beside it. Teams still opens the full profile.
  const flowAgent = view === "flow" ? agentId : undefined;
  const [panelTab, setPanelTab] = useState<SideTab>("agent");
  const closePanel = useCallback(() => setSearch({ agent: null }), [setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader center={
          <Segmented
            value={view}
            options={VIEWS}
            onChange={(v) => setSearch({ view: v === "flow" ? "flow" : null, agent: null, team: null })}
          />
        }>
          <span className={headerTitle}>Agents</span>
        </PageHeader>
        <InsetPanel pattern="grid" wide={view === "flow"} aside={view === "flow"
          ? <AgentProfilePanel inline agent={agentOf(flowAgent ?? "studio-head")} open={!!flowAgent} tab={panelTab} onTabChange={setPanelTab} onClose={closePanel} />
          : undefined}>
          {view === "flow"
            ? <FlowView selected={flowAgent} onOpenAgent={(id) => setSearch({ agent: id === flowAgent ? null : id, team: null })} />
            : agentId
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
    </div>
  );
}

function AgentProfile({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const registry = useRegistry();
  const profile = [...registry.agents, ...registry.communityAgents].find((p) => p.agent.id === agentId);
  if (!profile) return <p className="px-6 py-8 text-sm text-muted-foreground">No agent named {agentId}.</p>;
  return <ExpandedCard profile={profile} onClose={onBack} />;
}
