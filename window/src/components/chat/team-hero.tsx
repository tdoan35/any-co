import { Link } from "react-router";
import { useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeftRight, ArrowUpRight, Check, Crown, Play, Plus, Users, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Group, panel, pill } from "@/components/studio/studio-ui";
import type { ChatAgent } from "@fabric/contracts";
import { profileById } from "@/lib/registry";
import type { StudioTeam } from "@/lib/mock/teams";
import { cn } from "@/lib/utils";
import { TeamLoops } from "@/components/work/team-loops";
import { teamLoopCount } from "@/lib/work";
import { ChevronButton, FLY, Portrait, nameLayoutId, portraitLayoutId, ring, scrollArea } from "./assistant-hero";

export const teamLead = (team: StudioTeam): ChatAgent => profileById(team.members.find((m) => m.lead)!.agentId).agent;

/** Overlapping member portraits. The lead is crowned when `crown` is set. */
export function TeamStack({ team, size = "size-7", skipLead, crown }: { team: StudioTeam; size?: string; skipLead?: boolean; crown?: boolean }) {
  return (
    <div className="flex -space-x-2">
      {team.members.filter((m) => !(skipLead && m.lead)).map((m) => {
        const { agent } = profileById(m.agentId);
        return (
          <div key={m.agentId} title={`${agent.name} · ${agent.role}${m.lead ? " · Lead" : ""}`} className="relative rounded-full ring-2 ring-background">
            <Portrait agent={agent} className={cn(size, "border border-foreground/20 text-xs")} />
            {crown && m.lead && <Crown className="absolute -left-1 -top-1 z-10 size-3.5 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Hero for Teams mode: the team's lead as the portrait, the team name as the pill, and the rest of the
 * roster tucked underneath. The last slot ("Create a team") hands you to Dana, who proposes one.
 * Messages go straight to the lead.
 */
export function TeamHero({ teams, index, onIndexChange, onProfileToggle, className }: {
  teams: StudioTeam[]; index: number; onIndexChange: Dispatch<SetStateAction<number>>; onProfileToggle: () => void; className?: string;
}) {
  const total = teams.length + 1;
  const team: StudioTeam | undefined = teams[index];
  const agent = team ? teamLead(team) : profileById("dana").agent;
  const [dir, setDir] = useState<1 | -1>(1);

  const jump = (i: number) => { setDir(i > index ? 1 : -1); onIndexChange(i); };
  const step = (d: 1 | -1) => { setDir(d); onIndexChange((i) => (i + d + total) % total); };

  return (
    <div
      className={cn("group/hero relative flex w-80 flex-col items-center py-1", className)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget.querySelector("[data-portrait]")) return;
        if (e.key === "ArrowLeft") step(-1);
        if (e.key === "ArrowRight") step(1);
      }}
    >
      <ChevronButton side="left" label="Previous team" onClick={() => step(-1)} />
      <ChevronButton side="right" label="Next team" onClick={() => step(1)} />

      <div key={team?.id ?? "create"} className={cn("flex flex-col items-center animate-in fade-in-0 duration-200", dir > 0 ? "slide-in-from-right-3" : "slide-in-from-left-3")}>
        <span className="relative z-0 -mb-1.5 inline-flex -translate-y-[3px] h-6 items-center rounded-full border bg-card/60 px-2.5 opacity-0 transition-opacity duration-150 group-hover/hero:opacity-100 group-focus-within/hero:opacity-100 text-xs font-medium capitalize text-muted-foreground shadow-xs">
          {team ? `Lead · ${agent.role}` : "New team"}
        </span>
        <div className="relative">
          {team && <MemberColumn team={team} />}
          <button type="button" data-portrait onClick={onProfileToggle} aria-label={`Toggle ${team?.name ?? "Create a team"}'s profile`} className="group relative z-10 block rounded-full outline-none">
            <motion.div layoutId={portraitLayoutId(agent.id)} transition={FLY} className="rounded-full">
              <Portrait
                agent={agent}
                className={cn("relative size-28 cursor-pointer transition-transform duration-200 group-hover:scale-105 group-hover:animate-[avatar-glow_1.8s_ease-in-out_infinite] group-focus-visible:animate-[avatar-glow_1.8s_ease-in-out_infinite] group-focus-visible:border-foreground/60", ring)}
              />
            </motion.div>
          </button>
        </div>

        <div className="relative z-10 -mt-3">
          <motion.span layoutId={nameLayoutId(agent.id)} transition={FLY} className="block rounded-full border bg-card px-3 py-1 text-sm font-medium shadow-xs">{team?.name ?? "Create a team"}</motion.span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button" variant="ghost" size="icon" aria-label={`Switch team (now ${team?.name ?? "Create a team"})`}
                className="absolute left-full top-1/2 -mt-3.5 ml-1.5 size-7 rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground group-hover/hero:opacity-100 group-focus-within/hero:opacity-100 data-[state=open]:opacity-100"
              >
                <ArrowLeftRight className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-72">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Brief a team</DropdownMenuLabel>
              {teams.map((t, i) => (
                <DropdownMenuItem key={t.id} onSelect={() => jump(i)} className="gap-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">Led by {teamLead(t).name} · {t.members.length} members</span>
                  </span>
                  <TeamStack team={t} size="size-6" />
                  {i === index && <Check className="size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => jump(teams.length)} className="gap-2.5">
                <span className="grid size-6 place-items-center rounded-full border border-dashed text-muted-foreground"><Plus className="size-3.5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">Create a team</span>
                  <span className="block truncate text-xs text-muted-foreground">Dana proposes one for you</span>
                </span>
                {index === teams.length && <Check className="size-3.5 shrink-0" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

      </div>

      <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/hero:opacity-100 group-focus-within/hero:opacity-100">
        <span className="sr-only">{`Team ${index + 1} of ${total}`}</span>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-1 rounded-full transition-all", i === index ? "w-4 bg-foreground/50" : "w-1 bg-foreground/20")} />
        ))}
      </div>
    </div>
  );
}

/** The rest of the roster as a vertical stack to the right of the lead, centred on the portrait. Out of flow, so the hero keeps the agent hero's layout. */
function MemberColumn({ team }: { team: StudioTeam }) {
  const others = team.members.filter((m) => !m.lead).slice(0, 4);
  return (
    <div className="absolute left-full top-1/2 ml-3 flex -translate-y-1/2 flex-col -space-y-2">
      {others.map((m, i) => {
        const { agent } = profileById(m.agentId);
        return (
          <div
            key={m.agentId}
            title={`${agent.name} · ${agent.role}`}
            style={{ animationDelay: `${i * 50}ms` }}
            className="rounded-full ring-2 ring-background animate-in fade-in-0 slide-in-from-left-2 duration-300 fill-mode-backwards"
          >
            <Portrait agent={agent} className="size-8 border border-foreground/20 text-sm" />
          </div>
        );
      })}
    </div>
  );
}


/** Team tab of the side card: Members / Workflow / Runs, condensed to one column. */
export function TeamProfile({ team }: { team: StudioTeam }) {
  const lead = teamLead(team);
  const active = team.status === "active";
  return (
    <Tabs key={team.id} defaultValue="members" className="min-h-0 flex-1 gap-0">
      <header className="flex shrink-0 flex-col items-center gap-3 p-6 pb-4 pt-4 text-center">
        <TeamStack team={team} size="size-14" crown />
        <div>
          <h2 className="text-lg font-semibold leading-none">{team.name}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">Led by {lead.name}</p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{team.purpose}</p>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", active ? "bg-ok-soft text-ok" : "bg-foreground/5 text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", active ? "bg-ok" : "bg-muted-foreground/60")} />{active ? "Active" : "Idle"}
        </span>
      </header>
      <div className="shrink-0 border-b px-4 pb-3">
        <TabsList className="w-full bg-foreground/5">
          <TabsTrigger value="members" className="flex-1"><Users />Members<span className="tabular-nums text-muted-foreground">{team.members.length}</span></TabsTrigger>
          <TabsTrigger value="workflow" className="flex-1"><Workflow />Workflow</TabsTrigger>
          <TabsTrigger value="runs" className="flex-1"><Play />Loops<span className="tabular-nums text-muted-foreground">{teamLoopCount(team.id)}</span></TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="members" className={cn(scrollArea, "space-y-2")}>
        {team.members.map((m) => {
          const { agent } = profileById(m.agentId);
          return (
            <div key={m.agentId} className={cn(panel, "flex items-start gap-3 px-3 py-2.5")}>
              <Portrait agent={agent} className="size-9 shrink-0 border border-foreground/20 text-sm" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">{agent.name}{m.lead && <span className={pill}>Lead</span>}</div>
                <div className="text-xs text-muted-foreground">{agent.role}</div>
                <p className="mt-1 text-xs leading-snug text-foreground/80">{m.duty}</p>
              </div>
            </div>
          );
        })}
        <Button variant="outline" size="sm" asChild className="mt-2"><Link to="/agents?view=teams">Open in Teams <ArrowUpRight /></Link></Button>
      </TabsContent>

      <TabsContent value="workflow" className={cn(scrollArea, "space-y-5")}>
        <Group title="Stages" count={team.workflow.length}>
          <ol className={cn(panel, "divide-y divide-foreground/10")}>
            {team.workflow.map((s, i) => (
              <li key={s.label} className="flex gap-3 px-3 py-2.5">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-foreground/5 text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">{s.label}{s.gate && <span className={pill}>Review gate</span>}</div>
                  <div className="text-xs text-muted-foreground">{s.agentIds.map((id) => profileById(id).agent.name).join(" · ")}</div>
                  <p className="mt-1 text-xs leading-snug text-foreground/80">{s.note}</p>
                </div>
              </li>
            ))}
          </ol>
        </Group>
        <Group title="Done when">
          <ul className={cn(panel, "divide-y divide-foreground/10")}>
            {team.criteria.map((c) => <li key={c} className="flex gap-2 px-3 py-2 text-xs leading-snug"><Check className="mt-0.5 size-3 shrink-0 text-ok" />{c}</li>)}
          </ul>
        </Group>
        <p className="text-xs text-muted-foreground">Rework budget: {team.reworkBudget}. After that the lead escalates.</p>
      </TabsContent>

      <TabsContent value="runs" className={scrollArea}>
        <TeamLoops team={team} />
      </TabsContent>
    </Tabs>
  );
}
