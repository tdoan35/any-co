import { useMemo, useState } from "react";
import { Link, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { LayoutGroup } from "motion/react";
import { ArrowDownUp, ChevronRight, Crown, FolderOpen, Hourglass, Info, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/shell/app-shell";
import { PANEL_PATTERN, Segmented, headerButton, headerTitle } from "@/components/studio/studio-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { quietScroll } from "@/components/weave/use-edge-fade";
import { Face, agentOf } from "@/components/weave/parts";
import { studioTeams, useRegistry } from "@/lib/registry";
import type { StudioTeam } from "@fabric/contracts";
import type { Project } from "@/lib/mock/sessions";
import { api, httpMode } from "@/lib/api";
import { isActive } from "@/lib/run-state";
import type { Run, Task } from "@/lib/types";
import { COLUMNS, activityAt, byUrgency, leadOf, previousLoops, summarize, teamById, waitingCount, when, type Column, type TaskSummary } from "@/lib/work";
import { useWeave } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { PreviousLoops } from "./history";
import { FaceStack, card } from "./parts";
import { TaskCard } from "./task-card";

type Lens = "projects" | "teams";
const LENSES = [{ value: "projects", label: "Projects" }, { value: "teams", label: "Teams" }] as const;
type ProjectTab = "board" | "history";
const PROJECT_TABS = [{ value: "board", label: "Board" }, { value: "history", label: "History" }] as const;

/**
 * Work: every task as a card, current and previous loops.
 * Projects (the default) lists projects, most in need of you first; opening one shows its board,
 * with columns every team shares, and its history of finished loops. Teams shows one team's own
 * workflow steps as columns. Weave pushes what needs you; this is where you look.
 */
export function WorkBoard({ projects, tasks, runs }: { projects: Project[]; tasks: Task[]; runs: Run[] }) {
  useRegistry();
  const weave = useWeave();
  const [params, setParams] = useSearchParams();
  const lens: Lens = params.get("view") === "teams" ? "teams" : "projects";
  const focus = projects.find((p) => p.id === params.get("project"));
  const team = studioTeams().find((t) => t.id === params.get("team")) ?? studioTeams()[0];
  const summaries = useMemo(() => tasks.map((t) => summarize(t, runs, weave)), [tasks, runs, weave]);

  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });

  const scope: Scope = params.get("scope") === "archived" ? "archived" : "active";
  const tab: ProjectTab = params.get("tab") === "history" ? "history" : "board";
  const waitingOnYou = summaries.reduce((n, s) => n + waitingCount(s), 0);
  const inFlight = summaries.filter((s) => s.column === "in_progress" || s.column === "in_review").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        center={<Segmented value={lens} options={LENSES} onChange={(v) => set({ view: v === "teams" ? "teams" : null })} />}
        right={<span className="hidden text-xs text-muted-foreground lg:inline">{inFlight} in flight{waitingOnYou > 0 && <> · <span className="text-warn">{waitingOnYou} waiting on you</span></>}</span>}
      >
        <span className={cn(headerTitle, "flex items-center gap-2")}>
          {lens === "projects" && focus
            ? <><Link to="/work" className="font-normal text-muted-foreground hover:text-foreground">Work</Link><span className="font-normal text-muted-foreground">/</span>{focus.name}</>
            : "Work"}
        </span>
      </PageHeader>
      <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
        {/* Each view puts a fixed header bar above one gridded scroller (both axes), so column heads stick to the scroller's top edge. */}
        <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-background/20 shadow-sm backdrop-blur-xl">
          <LayoutGroup>
            {lens === "projects"
              ? focus
                ? <ProjectBoard project={focus} summaries={summaries.filter((s) => s.task.projectId === focus.id)} tab={tab} onTab={(v) => set({ tab: v === "history" ? "history" : null })} />
                : <ProjectIndex projects={projects} summaries={summaries} scope={scope} onScope={(v) => set({ scope: v === "archived" ? "archived" : null })} />
              : <TeamsLens team={team} projects={projects} summaries={summaries} onTeam={(id) => set({ team: id })} />}
          </LayoutGroup>
        </div>
      </div>
    </div>
  );
}

function ColumnHead({ label, count, hint, children }: { label: string; count: number; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-xs font-medium">
      {children}
      <span className="truncate">{label}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
      {hint && (
        <Tooltip>
          <TooltipTrigger asChild><Info className="size-3 shrink-0 text-muted-foreground/70" /></TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-56">{hint}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** A view's header bar: outside the scroller, so the grid stays in the content beneath it. */
const panelHeader = "flex shrink-0 items-center border-b border-foreground/10 bg-background/50 px-5";
/** A view's content: the panel's one scroller, and the only part with the grid. */
const panelBody = cn("min-h-0 flex-1 overflow-auto", PANEL_PATTERN.grid, quietScroll);

/** Column heads stay pinned while the cards scroll under them: full-bleed, and translucent, with the content blurred beneath. */
const stickyHead = "sticky top-0 z-20 -mx-5 border-b border-foreground/10 bg-background/50 px-5 py-2.5 backdrop-blur-xl";

function Cards({ items, lens, projects }: { items: TaskSummary[]; lens: "project" | "team"; projects: Project[] }) {
  return (
    <div className="flex min-h-16 flex-col gap-2.5">
      {items.map((s) => <TaskCard key={s.task.id} s={s} lens={lens} project={projects.find((p) => p.id === s.task.projectId)} />)}
    </div>
  );
}

/* ── Projects ─────────────────────────────────────────────────────── */

/** Column tones for the status bar: the same hues the cards' pills use. */
const COLUMN_TONE: Record<Column, string> = { proposed: "bg-replay", in_progress: "bg-run", in_review: "bg-run/45", done: "bg-ok" };

type Scope = "active" | "archived";
const SCOPES = [{ value: "active", label: "Your projects" }, { value: "archived", label: "Archived" }] as const;
type Order = "needs" | "recent" | "name";
const ORDERS: { value: Order; label: string }[] = [
  { value: "needs", label: "Needs you first" },
  { value: "recent", label: "Recently active" },
  { value: "name", label: "Name" },
];

/** Every project as one row, by default the ones waiting on you first, then the most recently active. Opening one shows its board. */
function ProjectIndex({ projects, summaries, scope, onScope }: { projects: Project[]; summaries: TaskSummary[]; scope: Scope; onScope: (v: Scope) => void }) {
  const [order, setOrder] = useState<Order>("needs");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = query.trim().toLowerCase();
  const rows = projects
    .filter((p) => !!p.archived === (scope === "archived"))
    .filter((p) => !q || `${p.name} ${p.goal}`.toLowerCase().includes(q))
    .map((p) => {
      const mine = summaries.filter((s) => s.task.projectId === p.id);
      return {
        project: p, mine,
        waiting: mine.reduce((n, s) => n + waitingCount(s), 0),
        last: mine.map(activityAt).sort().at(-1),
      };
    })
    .sort((a, b) => {
      const recent = (b.last ?? "").localeCompare(a.last ?? "");
      if (order === "name") return a.project.name.localeCompare(b.project.name);
      if (order === "recent") return recent;
      return b.waiting - a.waiting || recent;
    });
  const closeSearch = () => { setQuery(""); setSearching(false); };
  return (
    <>
      <div className={cn(panelHeader, "h-12 gap-2")}>
        <Segmented value={scope} options={SCOPES} onChange={onScope} />
        <div className="ml-auto flex items-center gap-1">
          {searching
            ? (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
                  onBlur={() => { if (!query.trim()) closeSearch(); }}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  className="h-7 w-52 pl-7 text-xs"
                />
              </div>
            )
            : <Button variant="ghost" size="icon-sm" aria-label="Search projects" title="Search" onClick={() => setSearching(true)}><Search /></Button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Order projects" title={`Order: ${ORDERS.find((o) => o.value === order)!.label}`} className={cn(order !== "needs" && "text-foreground bg-foreground/5")}><ArrowDownUp /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Order by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={order} onValueChange={(v) => setOrder(v as Order)}>
                {ORDERS.map((o) => <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {!httpMode && <Button size="sm" variant="outline" className={cn(headerButton, "ml-1 h-7")} onClick={() => setCreating(true)}><Plus />New project</Button>}
        </div>
      </div>
      <div className={cn(panelBody, "px-5 pb-8 pt-5")}>
        {rows.length === 0
          ? (
            <p className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">
              {q ? <>No projects match “{query.trim()}”.</> : scope === "archived" ? "Nothing archived. Archived projects keep their history and leave the sidebar." : "No projects yet. Start one, and Dana can file work under it."}
            </p>
          )
          : (
            <ul className={cn(card, "divide-y divide-foreground/10")}>
              {rows.map(({ project, mine, waiting, last }) => {
                const teams = [...new Set(mine.map((s) => s.task.teamId))].map(teamById);
                return (
                  <li key={project.id}>
                    <Link
                      to={`/work?project=${project.id}`}
                      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-foreground/5 md:grid-cols-[minmax(0,1fr)_auto_9rem_auto]"
                    >
                      <span className="flex min-w-0 items-start gap-2.5">
                        <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{project.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{project.goal}</span>
                        </span>
                      </span>
                      <span className="hidden md:flex">
                        {teams.length > 0 && <FaceStack ids={teams.map(leadOf)} size="size-5" />}
                      </span>
                      <span className="hidden md:block">
                        {mine.length ? <StatusBar summaries={mine} /> : <span className="text-xs text-muted-foreground">No work yet</span>}
                      </span>
                      <span className="flex items-center justify-end gap-3">
                        {waiting > 0 && (
                          <span className="inline-flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">
                            <Hourglass className="size-3" />{waiting} waiting on you
                          </span>
                        )}
                        <span className="hidden w-14 text-right text-xs tabular-nums text-muted-foreground sm:inline">{last ? when(last) : ""}</span>
                        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** Name and goal are all a project needs; its board opens empty, ready for Dana's first proposal. */
function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const project = await api.createProject({ name: name.trim(), goal: goal.trim() });
    await revalidator.revalidate();
    setSaving(false); setName(""); setGoal("");
    onOpenChange(false);
    navigate(`/work?project=${project.id}`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>A project groups the work toward one outcome. Its threads and tasks file under it.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-xs font-medium">
            Name
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Engram on small models" />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Goal
            <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What are you trying to find out or ship?" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || saving}>Create project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Where a project's tasks sit across the four columns, as one bar plus the task count. */
function StatusBar({ summaries }: { summaries: TaskSummary[] }) {
  const counts = COLUMNS.map((c) => ({ ...c, n: summaries.filter((s) => s.column === c.id).length }));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block space-y-1">
          <span className="flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/10">
            {counts.filter((c) => c.n).map((c) => <span key={c.id} className={COLUMN_TONE[c.id]} style={{ flexGrow: c.n }} />)}
          </span>
          <span className="block text-[11px] tabular-nums text-muted-foreground">
            {summaries.length} {summaries.length === 1 ? "task" : "tasks"} · {counts.find((c) => c.id === "done")!.n} done
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {counts.map((c) => (
          <div key={c.id} className="flex items-center gap-2"><span className={cn("size-2 rounded-full", COLUMN_TONE[c.id])} />{c.label}<span className="ml-auto pl-4 tabular-nums">{c.n}</span></div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** Done keeps only the latest few on the board; the rest stay a click away, and every loop is in History. */
const DONE_SHOWN = 3;

/** One project: its board of tasks, or its history of finished loops. */
function ProjectBoard({ project, summaries, tab, onTab }: { project: Project; summaries: TaskSummary[]; tab: ProjectTab; onTab: (v: ProjectTab) => void }) {
  const [allDone, setAllDone] = useState(false);
  const teams = [...new Set(summaries.map((s) => s.task.teamId))].map(teamById);
  const loops = previousLoops(summaries);
  const count = (c: Column) => summaries.filter((s) => s.column === c).length;
  return (
    <>
      <div className={cn(panelHeader, "min-w-0 items-start gap-4 py-4")}>
        <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{project.name}</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{project.goal}</p>
          {teams.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {teams.map((t) => (
                <Link key={t.id} to={`/work?view=teams&team=${t.id}`} className="-ml-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-foreground/5 hover:text-foreground" title={`${t.name} · led by ${agentOf(leadOf(t)).name}`}>
                  <Face id={leadOf(t)} size="size-5" />{t.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <Segmented value={tab} options={PROJECT_TABS} onChange={onTab} />
      </div>
      <div className={panelBody}>
        {tab === "history"
          ? <div className="px-5 pb-8 pt-5"><PreviousLoops loops={loops} projects={[project]} lens="project" /></div>
          : summaries.length === 0
            ? <p className="m-5 rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">No work in this project yet. Ask the Studio Head in one of its threads, and her proposal lands here.</p>
            : (
              <div className="min-w-[880px] px-5 pb-8">
                <div className={cn(stickyHead, "grid grid-cols-4 gap-4")}>
                  {COLUMNS.map((c) => <ColumnHead key={c.id} label={c.label} count={count(c.id)} hint={c.hint} />)}
                </div>
                <div className="grid grid-cols-4 gap-4 pt-4">
                  {COLUMNS.map((c) => {
                    const items = summaries.filter((s) => s.column === c.id).sort(byUrgency);
                    const capped = c.id === "done" && !allDone && items.length > DONE_SHOWN;
                    return (
                      <div key={c.id} className="flex flex-col gap-2.5">
                        <Cards items={capped ? items.slice(0, DONE_SHOWN) : items} lens="project" projects={[project]} />
                        {c.id === "done" && items.length > DONE_SHOWN && (
                          <button type="button" onClick={() => setAllDone(!allDone)} className="self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
                            {allDone ? "Show fewer" : `Show all ${items.length}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {loops.length > 0 && (
                  <button type="button" onClick={() => onTab("history")} className="mt-6 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
                    {loops.length} finished {loops.length === 1 ? "loop" : "loops"} in History<ChevronRight className="size-3" />
                  </button>
                )}
              </div>
            )}
      </div>
    </>
  );
}

/* ── Teams ─────────────────────────────────────────────────────────── */

const OCCUPIED_W = 220, EMPTY_W = 120;

function TeamsLens({ team, projects, summaries, onTeam }: { team: StudioTeam; projects: Project[]; summaries: TaskSummary[]; onTeam: (id: string) => void }) {
  const YOUR_TEAMS = studioTeams().map((t) => ({ value: t.id, label: t.name }));
  const mine = summaries.filter((s) => s.task.teamId === team.id);
  // Proposed and Done bracket the team's own steps; Proposed only shows when something is proposed.
  const proposed = mine.filter((s) => s.column === "proposed");
  const columns = [
    ...(proposed.length ? [{ id: "proposed", label: "Proposed", items: proposed }] : []),
    ...team.workflow.map((w, i) => ({
      id: w.label, label: w.label, step: i + 1, gate: w.gate, agentIds: w.agentIds,
      items: mine.filter((s) => (s.column === "in_progress" || s.column === "in_review") && s.stage === w.label),
    })),
    { id: "done", label: "Done", items: mine.filter((s) => s.column === "done") },
  ];
  // Steps with nothing in them narrow, so the occupied ones have room for cards.
  const template = columns.map((c) => (c.items.length ? `minmax(${OCCUPIED_W}px, 1fr)` : `minmax(${EMPTY_W}px, 0.55fr)`)).join(" ");
  const minWidth = columns.reduce((n, c) => n + (c.items.length ? OCCUPIED_W : EMPTY_W), 0);
  const loops = mine.reduce((n, s) => n + s.loops.length, 0);
  return (
    <>
      <div className={cn(panelHeader, "h-12 gap-4")}>
        <Segmented value={team.id} options={YOUR_TEAMS} onChange={onTeam} />
        <p className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          Led by {agentOf(leadOf(team)).name} · rework budget {team.reworkBudget} · {mine.length} {mine.length === 1 ? "task" : "tasks"}, {loops} {loops === 1 ? "loop" : "loops"} ·{" "}
          <Link to="/agents?view=teams" className="underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground">How this team works</Link>
        </p>
      </div>
      <div className={panelBody}>
        <div className="pb-8" style={{ minWidth }}>
          <TeamMembers team={team} summaries={mine} />
          {/* The board itself sits on a plain surface, one bordered lane per step. */}
          <div className="grid border-y border-foreground/10 bg-background/70" style={{ gridTemplateColumns: template }}>
            {columns.map((c, i) => (
              <section key={c.id} aria-label={c.label} className={cn("flex min-h-72 min-w-0 flex-col", i > 0 && "border-l border-foreground/10")}>
                <div className="sticky top-0 z-20 border-b border-foreground/10 bg-background/50 px-3 py-2.5 backdrop-blur-xl">
                  <ColumnHead label={c.label} count={c.items.length} hint={"gate" in c && c.gate ? `The review step: it can send work back to ${agentOf(leadOf(team)).name}, up to ${team.reworkBudget} times.` : undefined}>
                    {"step" in c && <span className={cn("grid size-4 shrink-0 place-items-center text-[10px] tabular-nums text-muted-foreground ring-1 ring-foreground/15", c.gate ? "rotate-45 rounded-[3px]" : "rounded-full")}><span className={cn(c.gate && "-rotate-45")}>{c.step}</span></span>}
                  </ColumnHead>
                </div>
                <div className="p-3"><Cards items={c.items.sort(byUrgency)} lens="team" projects={projects} /></div>
              </section>
            ))}
          </div>
          <div className="mt-8 px-5"><PreviousLoops loops={previousLoops(mine)} projects={projects} lens="team" /></div>
        </div>
      </div>
    </>
  );
}

/** What each member is doing across the team's live loops right now. */
function TeamMembers({ team, summaries }: { team: StudioTeam; summaries: TaskSummary[] }) {
  const live = summaries.filter((s) => s.latest && (s.column === "in_progress" || s.column === "in_review") && !s.note);
  const memberNow = (agentId: string) => {
    const where = (kinds: string[]) => live.filter((s) => s.latest!.segments.some((x) => x.agentId === agentId && kinds.includes(x.kind) && isActive(s.latest!, x, s.latest!.durationS)));
    const waiting = where(["wait"]), working = where(["work", "rework"]), blocked = where(["blocked"]);
    const others = studioTeams().filter((t) => t.id !== team.id && t.members.some((m) => m.agentId === agentId));
    return {
      state: waiting.length ? "waiting" : working.length ? "working" : "idle",
      text: waiting.length ? "Needs you" : working.length ? "Working" : blocked.length ? "Blocked" : "Idle",
      detail: [
        ...waiting.map((s) => `Waiting on you · ${s.task.title}`),
        ...working.map((s) => `Working · ${s.task.title}`),
        ...blocked.map((s) => `Blocked on a teammate · ${s.task.title}`),
        ...others.map((t) => `Also on ${t.name}`),
      ],
    };
  };
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <span className="text-xs font-medium text-muted-foreground">Now</span>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {team.members.map((m) => {
          const now = memberNow(m.agentId);
          return (
            <li key={m.agentId}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link to={`/agents?agent=${m.agentId}`} className="flex items-center gap-2 rounded-lg py-0.5 pr-1.5 hover:bg-foreground/5">
                    <span className={cn("relative flex shrink-0 rounded-full ring-2 ring-offset-1 ring-offset-transparent", now.state === "waiting" ? "ring-warn" : now.state === "working" ? "ring-run" : "ring-foreground/10")}>
                      <Face id={m.agentId} size="size-7" />
                      {m.lead && <Crown className="absolute -left-1.5 -top-1.5 size-3.5 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
                    </span>
                    <span className="text-xs leading-tight">
                      <span className="block font-medium">{agentOf(m.agentId).name}</span>
                      <span className={cn("block", now.state === "waiting" ? "text-warn" : now.state === "working" ? "text-run" : "text-muted-foreground")}>{now.text}</span>
                    </span>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64">
                  <div className="font-medium">{agentOf(m.agentId).name} · {m.duty}</div>
                  {now.detail.map((d) => <div key={d}>{d}</div>)}
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
