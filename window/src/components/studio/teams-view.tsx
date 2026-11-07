import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowRight, CornerDownLeft, Crown, Folder, ListChecks, Play, Plus, Users, Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Portrait, ring } from "@/components/chat/assistant-hero";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { profileById, useRegistry } from "@/lib/registry";
import { httpMode } from "@/lib/api";
import type { Organization, Presence, PresenceState, StudioTeam } from "@fabric/contracts";
import { TeamLoops } from "@/components/work/team-loops";
import { lastLoopAt, leadOf, teamLoopCount } from "@/lib/work";
import { useWeave } from "@/lib/weave-store";
import { EASE, Group, SectionHead, panel, pill, surface } from "./studio-ui";

type Section = "mine" | "community";
export type TeamsView = "teams" | "orgs";
const cardId = (id: string) => `team-card-${id}`;
const formatInstalls = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** The Teams and Organizations panes of the studio page. The page owns the header and the view switch. */
export function TeamsStudio({ view, onViewChange }: { view: TeamsView; onViewChange: (v: TeamsView) => void }) {
  const registry = useRegistry();
  const [localAdds, setLocalAdds] = useState<string[]>([]);
  const mine = [...registry.teams, ...registry.communityTeams.filter((t) => localAdds.includes(t.id)).map((t) => ({ ...t, origin: `From ${t.author}` }))];
  const community = registry.communityTeams.filter((t) => !localAdds.includes(t.id));
  const [sel, setSel] = useState<{ id: string; from: Section } | null>(null);
  const orgs = registry.organizations;

  const add = (id: string) => {
    const t = community.find((c) => c.id === id);
    if (!t) return;
    setLocalAdds((ids) => [...ids, t.id]);
    setSel(null);
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
        {view === "teams"
          ? <TeamsView mine={mine} community={community} sel={sel} onSelect={setSel} onAdd={add} />
          : (
            <OrgView
              orgs={orgs} teams={mine}
              onOpen={(id) => { setSel({ id, from: "mine" }); onViewChange("teams"); }}
            />
          )}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Your teams and community teams. Opening a card expands it in place
 * (Members · Workflow · Runs) and fades the other section out.
 */
function TeamsView({ mine, community, sel, onSelect, onAdd }: {
  mine: StudioTeam[]; community: StudioTeam[]; sel: { id: string; from: Section } | null;
  onSelect: (s: { id: string; from: Section } | null) => void; onAdd: (id: string) => void;
}) {
  const close = useCallback(() => onSelect(null), [onSelect]);
  const selected = sel && (sel.from === "mine" ? mine : community).find((t) => t.id === sel.id);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, close]);

  return (
    <LayoutGroup>
      <div className="flex flex-col gap-10">
        <AnimatePresence initial={false} mode="popLayout">
          {sel?.from !== "community" && (
            <motion.section key="mine" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Departments" count={mine.length} hint="Each department groups the agents that share a dept in their spec." />
              {selected && sel?.from === "mine"
                ? <ExpandedTeam team={selected} teams={mine} onClose={close} />
                : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {mine.map((t) => <TeamCard key={t.id} team={t} onOpen={() => onSelect({ id: t.id, from: "mine" })} />)}
                  </div>
                )}
            </motion.section>
          )}
          {sel?.from !== "mine" && (
            <motion.section key="community" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Community teams" count={community.length} hint="Teams shared by others. Adding one brings its members along, with empty memories." />
              {selected && sel?.from === "community"
                ? <ExpandedTeam team={selected} teams={mine} onClose={close} onAdd={() => onAdd(selected.id)} />
                : community.length > 0
                  ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {community.map((t) => <CommunityTeamCard key={t.id} team={t} onOpen={() => onSelect({ id: t.id, from: "community" })} onAdd={() => onAdd(t.id)} />)}
                    </div>
                  )
                  : <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">You&apos;ve added every community team.</p>}
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

function OrgView({ orgs, teams, onOpen }: { orgs: Organization[]; teams: StudioTeam[]; onOpen: (teamId: string) => void }) {
  return (
    <section>
      <SectionHead
        title="Organization"
        count={orgs.length}
        hint="The Studio Head sits at the top; each box is a department and its agents. A green dot means the agent is running a task right now. Click a department to open it."
      />
      <div className="flex flex-col gap-8">
        {orgs.map((o) => <OrgFolder key={o.id} org={o} teams={teams} onOpen={onOpen} />)}
        {orgs.length === 0 && <p className="rounded-xl border border-dashed border-foreground/15 px-3 py-8 text-center text-sm text-muted-foreground">No agent specs found in agents/.</p>}
      </div>
    </section>
  );
}

function StatusPill({ team }: { team: StudioTeam }) {
  const active = team.status === "active";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", active ? "bg-ok-soft text-ok" : "bg-foreground/5 text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", active ? "bg-ok" : "bg-muted-foreground/60")} />
      {active ? "Active" : "Idle"}
    </span>
  );
}

function AvatarStack({ team, size = "size-10" }: { team: StudioTeam; size?: string }) {
  return (
    <div className="flex -space-x-2.5">
      {team.members.map((m) => {
        const { agent } = profileById(m.agentId);
        return (
          <div key={m.agentId} title={`${agent.name} · ${agent.role}${m.lead ? " · Lead" : ""}`} className="relative rounded-full ring-2 ring-background/80">
            <Portrait agent={agent} className={cn(size, "border border-foreground/20")} />
            {m.lead && <Crown className="absolute -left-1 -top-1 z-10 size-4 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
          </div>
        );
      })}
    </div>
  );
}

function TeamCard({ team, onOpen }: { team: StudioTeam; onOpen: () => void }) {
  const lead = profileById(leadOf(team)).agent;
  const last = lastLoopAt(team.id);
  return (
    <motion.button
      type="button"
      layoutId={cardId(team.id)}
      transition={EASE}
      onClick={onOpen}
      style={{ borderRadius: 16 }}
      className={cn("group flex flex-col items-start gap-3 p-5 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring", surface)}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-base font-semibold">{team.name}</span>
        <StatusPill team={team} />
        <span className={cn(pill, "ml-auto")}>{team.origin}</span>
      </div>
      <p className="text-sm text-foreground/70">{team.tagline}</p>
      <AvatarStack team={team} />
      <p className="text-xs text-muted-foreground">
        {team.members.some((m) => m.lead) && <>Led by {lead.name} · </>}{team.members.length} {team.members.length === 1 ? "member" : "members"} · {last ? `last loop ${last}` : "no loops yet"}
      </p>
    </motion.button>
  );
}

function CommunityTeamCard({ team, onOpen, onAdd }: { team: StudioTeam; onOpen: () => void; onAdd: () => void }) {
  return (
    <motion.div layoutId={cardId(team.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("group relative transition-colors hover:border-foreground/20 hover:bg-background/80", surface)}>
      <button type="button" onClick={onOpen} className="flex w-full flex-col items-start gap-2.5 rounded-2xl p-4 pr-11 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{team.name}</div>
          <p className="truncate text-xs text-foreground/70">{team.tagline}</p>
        </div>
        <AvatarStack team={team} size="size-8" />
        <p className="text-[11px] text-muted-foreground">{team.author} · {formatInstalls(team.installs ?? 0)} added · {team.members.length} members</p>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" size="icon" variant="ghost" onClick={onAdd} aria-label={`Add ${team.name} to your teams`} className="absolute right-2 top-2 size-7 rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add to your teams</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

/* ── Expanded team ────────────────────────────────────────────────── */

function ExpandedTeam({ team, teams, onClose, onAdd }: { team: StudioTeam; teams: StudioTeam[]; onClose: () => void; onAdd?: () => void }) {
  return (
    <motion.div layoutId={cardId(team.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("overflow-hidden", surface, "bg-background/60")}>
      <div className="flex items-start gap-5 p-6 pb-5">
        <motion.div className="min-w-0 flex-1" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.3 } }}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{team.name}</h2>
            <StatusPill team={team} />
            {team.author ? <span className="text-xs text-muted-foreground">by {team.author}</span> : <span className={pill}>{team.origin}</span>}
          </div>
          <p className="mt-1.5 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{team.purpose}</p>
        </motion.div>
        <div className="flex shrink-0 items-center gap-1">
          {onAdd && <Button size="sm" className="h-8" onClick={onAdd}><Plus />Add to your teams</Button>}
          <Button size="icon" variant="ghost" className="size-8 rounded-full" onClick={onClose} aria-label="Close team"><X /></Button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.18, duration: 0.35 } }}>
        <Tabs defaultValue="members" className="gap-4 px-6 pb-6">
          <TabsList className="bg-foreground/5">
            <TabsTrigger value="members"><Users />Members<span className="tabular-nums text-muted-foreground">{team.members.length}</span></TabsTrigger>
            <TabsTrigger value="workflow"><Workflow />Workflow</TabsTrigger>
            <TabsTrigger value="runs"><Play />Loops<span className="tabular-nums text-muted-foreground">{teamLoopCount(team.id)}</span></TabsTrigger>
          </TabsList>
          <TabsContent value="members"><MembersTab team={team} teams={teams} /></TabsContent>
          <TabsContent value="workflow"><WorkflowTab team={team} /></TabsContent>
          <TabsContent value="runs"><TeamLoops team={team} /></TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
}

function MembersTab({ team, teams }: { team: StudioTeam; teams: StudioTeam[] }) {
  return (
    <ul className={cn(panel, "divide-y divide-foreground/10")}>
      {team.members.map((m) => {
        const { agent, origin } = profileById(m.agentId);
        const also = teams.filter((t) => t.id !== team.id && t.members.some((x) => x.agentId === m.agentId));
        return (
          <li key={m.agentId}>
            <Link to={`/agents?agent=${agent.id}`} className="group flex items-center gap-3 px-3 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-foreground/5">
              <Portrait agent={agent} className="size-10 border-2 border-foreground/25" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-muted-foreground">{agent.role}</span>
                  {m.lead && <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn"><Crown className="size-2.5" />Lead</span>}
                  {also.map((t) => <span key={t.id} className={pill}>Also on {t.name}</span>)}
                  {origin && <span className={pill}>{origin}</span>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{m.duty}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">Profile <ArrowRight className="size-3" /></span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function WorkflowTab({ team }: { team: StudioTeam }) {
  const lead = profileById(leadOf(team)).agent;
  return (
    <div className="grid gap-5 md:grid-cols-[1fr_260px]">
      <Group icon={Workflow} title="Steps">
        <ol className={cn(panel, "relative px-4 py-3")}>
          {team.workflow.map((st, i) => {
            const parallel = st.agentIds.length > 1;
            const last = i === team.workflow.length - 1;
            return (
              <li key={st.label} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && <span className="absolute left-[11px] top-7 bottom-1 w-px bg-foreground/15" />}
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/5 text-[11px] font-medium tabular-nums ring-1 ring-foreground/10">{i + 1}</span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {st.label}
                    {parallel && <span className={pill}>parallel</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">{st.note}</p>
                  {st.gate && (
                    <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-1 text-[11px] text-warn">
                      <CornerDownLeft className="size-3" />Changes requested → back to {lead.name} · rework budget {team.reworkBudget}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 -space-x-2 pt-0.5">
                  {st.agentIds.map((id) => {
                    const { agent } = profileById(id);
                    return <span key={id} title={agent.name} className="inline-flex rounded-full ring-2 ring-background/80"><Portrait agent={agent} className="size-7 border border-foreground/20" /></span>;
                  })}
                </div>
              </li>
            );
          })}
        </ol>
      </Group>
      <Group icon={ListChecks} title="Done when" count={team.criteria.length}>
        <ul className={cn(panel, "space-y-2 px-3 py-2.5 text-xs")}>
          {team.criteria.map((c) => (
            <li key={c} className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />{c}</li>
          ))}
        </ul>
      </Group>
    </div>
  );
}

/* ── Organization chart (folder, read-only) ──────────────────────── */

type Live = ReadonlyMap<string, Presence>;
const DOT: Record<PresenceState, string> = { working: "bg-ok", waiting: "bg-warn", blocked: "bg-destructive", idle: "bg-muted-foreground/40" };
const line = "bg-foreground/20";
/** Org-chart rail: each child draws its half on either side; the ends trim theirs. */
const branch = cn(
  "relative flex flex-col items-center",
  "before:absolute before:left-0 before:top-0 before:h-px before:w-1/2 before:bg-foreground/20 after:absolute after:right-0 after:top-0 after:h-px after:w-1/2 after:bg-foreground/20",
  "first:before:hidden last:after:hidden",
);

/** An org drawn as a file folder: the name on the tab, the org chart inside. Live presence comes from Weave. */
function OrgFolder({ org, teams, onOpen }: { org: Organization; teams: StudioTeam[]; onOpen: (teamId: string) => void }) {
  const live: Live = new Map(useWeave().presence.map((p) => [p.agentId, p]));
  const orgTeams = org.slots.flatMap(({ key, teamId }) => {
    const team = teams.find((t) => t.id === teamId);
    return team ? [{ key, team }] : [];
  });
  // An empty headId means no Studio Head spec exists yet: say so instead of promoting someone else.
  const head = org.headId ? profileById(org.headId)?.agent : undefined;
  const folderBg = "bg-background/55 backdrop-blur-md";
  // An agent on more than one team in this org is drawn under each, tagged "shared".
  const sharedIds = new Set(orgTeams.flatMap(({ team }) => team.members.map((m) => m.agentId)).filter((id, i, all) => all.indexOf(id) !== i));
  const workingNow = [...live.values()].filter((p) => p.state === "working").length;

  return (
    <div className="relative">
      <div className={cn("relative z-10 -mb-px inline-flex h-9 items-center gap-2 rounded-t-xl border border-b-0 border-foreground/10 pl-3.5 pr-3 text-sm", folderBg)}>
        <Folder className="size-4 text-muted-foreground" />
        <span className="font-semibold">{org.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{orgTeams.length} {orgTeams.length === 1 ? "department" : "departments"} · {workingNow} working</span>
      </div>

      <div style={{ borderRadius: 16, borderTopLeftRadius: 0 }} className={cn("border border-foreground/10 px-6 pb-6 pt-7 shadow-sm", folderBg)}>
        <div className="flex flex-col items-center">
          {head
            ? <OrgNode agent={head} size="size-16" subtitle={head.role} emphasis state={live.get(head.id)} />
            : <HeadPlaceholder />}
          {orgTeams.length > 0 && <span className={cn("h-6 w-px", line)} />}
        </div>

        <div className="-mx-6 overflow-x-auto px-6 pb-1 [scrollbar-width:none] hover:[scrollbar-width:thin]">
          <ul className="mx-auto flex w-max">
            {orgTeams.map(({ key, team }) => (
              <li key={key} className={cn(branch, "px-1.5 pt-6")}>
                <span className={cn("absolute left-1/2 top-0 h-6 w-px", line)} />
                <OrgTeamBox team={team} live={live} sharedIds={sharedIds} onOpen={() => onOpen(team.id)} />
              </li>
            ))}
          </ul>
        </div>

        {httpMode && org.handoffs.filter((edge) => orgTeams.some((slot) => slot.team.id === edge.from) && orgTeams.some((slot) => slot.team.id === edge.to)).map((edge) => (
          <div key={`${edge.from}-${edge.to}`} className="mx-auto mt-5 flex max-w-[510px] items-center gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 border-t border-dashed border-foreground/35" aria-hidden />
            <div className="rounded-lg border border-dashed border-foreground/25 bg-background/65 px-3 py-2 text-center">
              <span className="font-medium text-foreground">{teams.find((t) => t.id === edge.from)?.name} → {teams.find((t) => t.id === edge.to)?.name}</span>
              <span className="mt-0.5 block">{edge.question}</span>
              {edge.preview && <span className="mt-1 inline-block rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium">Preview — not built</span>}
            </div>
            <span className="min-w-0 flex-1 border-t border-dashed border-foreground/35" aria-hidden />
          </div>
        ))}
      </div>
    </div>
  );
}

function HeadPlaceholder() {
  return (
    <div className="flex w-44 flex-col items-center text-center" title="No agent spec with dept: head exists yet">
      <div className="grid size-16 place-items-center rounded-full border-2 border-dashed border-foreground/25 text-muted-foreground"><Crown className="size-5" /></div>
      <span className="mt-1.5 text-sm font-medium">Studio Head</span>
      <span className="text-xs text-muted-foreground">not created yet</span>
    </div>
  );
}

/** A department. With an explicit lead it is drawn lead-over-members; without one, as a row of peers. */
function OrgTeamBox({ team, live, sharedIds, onOpen }: { team: StudioTeam; live: Live; sharedIds: Set<string>; onOpen: () => void }) {
  const lead = team.members.find((m) => m.lead);
  const rest = team.members.filter((m) => !m.lead);
  const active = team.members.some((m) => live.get(m.agentId)?.state === "working");
  const node = (agentId: string, rest: Partial<Parameters<typeof OrgNode>[0]>) => {
    const { agent } = profileById(agentId);
    return <OrgNode agent={agent} size="size-10" subtitle={agent.role} state={live.get(agentId)} shared={sharedIds.has(agentId)} {...rest} />;
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(panel, "flex min-w-[200px] flex-col items-center px-3 pb-4 pt-3 outline-none transition-colors hover:border-foreground/20 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring", lead ? "min-h-[236px]" : "min-h-[150px]", !active && "border-dashed")}
    >
      <div className="mb-3 flex h-5 items-center gap-2 text-sm font-medium">
        {team.name}
        <StatusPill team={{ ...team, status: active ? "active" : "idle" }} />
      </div>
      {lead ? (
        <>
          {node(lead.agentId, { size: "size-14", lead: true, subtitle: `${profileById(lead.agentId).agent.role} · Lead` })}
          {rest.length > 0 && (
            <>
              <span className={cn("h-4 w-px", line)} />
              <ul className="flex">
                {rest.map((m) => (
                  <li key={m.agentId} className={cn(branch, "px-0.5 pt-4")}>
                    <span className={cn("absolute left-1/2 top-0 h-4 w-px", line)} />
                    {node(m.agentId, { compact: true })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <ul className="flex gap-1">
          {team.members.map((m) => <li key={m.agentId}>{node(m.agentId, { size: "size-12", compact: true, subtitle: profileById(m.agentId).agent.model.split("/").pop() ?? "" })}</li>)}
        </ul>
      )}
    </button>
  );
}

function OrgNode({ agent, size, subtitle, emphasis, lead, compact, shared, state }: {
  agent: ReturnType<typeof profileById>["agent"]; size: string; subtitle: string; emphasis?: boolean; lead?: boolean; compact?: boolean; shared?: boolean; state?: Presence;
}) {
  const s = state?.state ?? "idle";
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "w-[88px]" : "w-36")} title={state && s !== "idle" ? `${agent.name}: ${state.activity}` : agent.name}>
      <div className="relative">
        <Portrait agent={agent} className={cn(size, emphasis || lead ? ring : "border-2 border-foreground/25", s === "working" && "ring-2 ring-ok/60")} />
        {lead && <Crown className="absolute -left-1 -top-1 size-4 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
        <span className={cn("absolute bottom-0 right-0 size-3 rounded-full ring-2 ring-background", DOT[s], s === "working" && "animate-pulse")} aria-label={s} />
      </div>
      <span className={cn("mt-1.5 font-medium", compact ? "text-xs" : "text-sm")}>{agent.name}</span>
      <span className={cn("max-w-full truncate text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>{subtitle}</span>
      {s === "working" && !compact && state && <span className="mt-0.5 max-w-full truncate text-[11px] text-ok">{state.activity}</span>}
      {shared && <span className={cn(pill, "mt-1")}>shared</span>}
    </div>
  );
}
