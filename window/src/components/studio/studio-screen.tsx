import { Plus } from "lucide-react";
import { useSearchParams } from "react-router";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { httpMode } from "@/lib/api";
import { AgentStudio } from "./agent-studio";
import { TeamsStudio } from "./teams-view";
import { InsetPanel, Segmented, headerButton, headerTitle } from "./studio-ui";

type View = "agents" | "teams" | "orgs";
const VIEWS = [{ value: "orgs", label: "Org chart" }, { value: "agents", label: "Agents" }, { value: "teams", label: "Departments" }] as const;
const CREATE: Record<View, string> = { agents: "Create agent", teams: "Create team", orgs: "Create organization" };
const isView = (v: string | null): v is View => VIEWS.some((o) => o.value === v);

/**
 * Agent Studio: agents, teams and organizations behind one switch. The view lives in `?view=`
 * (agents when absent). Panes stay mounted while hidden so edits survive switching.
 */
export function StudioScreen() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const agent = params.get("agent") ?? undefined;
  // The org chart is the studio's front page; a deep link to an agent (?agent=) opens that agent instead.
  const view: View = isView(raw) ? raw : agent ? "agents" : "orgs";

  const setView = (v: View) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (v === "orgs") next.delete("view"); else next.set("view", v);
    return next;
  }, { replace: true });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        center={<Segmented value={view} options={VIEWS} onChange={setView} />}
        right={import.meta.env.VITE_DEMO === "1" || httpMode ? undefined : <Button size="sm" variant="outline" className={headerButton}><Plus />{CREATE[view]}</Button>}
      >
        <span className={headerTitle}>Studio</span>
      </PageHeader>
      <InsetPanel pattern={view === "agents" ? "dots" : "grid"}>
        <div className={cn(view !== "agents" && "hidden", "animate-in fade-in duration-200")}>
          <AgentStudio key={agent ?? ""} initialId={agent} />
        </div>
        <div className={cn(view === "agents" && "hidden", "animate-in fade-in duration-200")}>
          <TeamsStudio view={view === "orgs" ? "orgs" : "teams"} onViewChange={setView} />
        </div>
      </InsetPanel>
    </div>
  );
}
