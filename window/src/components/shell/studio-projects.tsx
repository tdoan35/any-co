// Sidebar Projects section: one link per project, straight to its board (Work / <Project>).
// - The active studio's rows are the Work view's own projects (api.listProjects, saved to the
//   registry store by the root and Work loaders): live, one per game plus "Studio"
//   (lib/api/board-view.ts); mock, the fixture projects. So the sidebar and the Work index
//   share projects and ids. The sidebar leaves out Studio, which stays on the Work index.
// - Each row links to /work?project=<id> and is active on that board or on one of its tasks.
//   On the right: how many asks wait on you in that project (amber, like the Studio nav
//   badge), and a green dot while one of its loops is running.
// - Other configured studios' data is not loaded, so their games come from their adapters'
//   GET /api/art-gallery repos (lib/studio-projects.ts) and carry a studio tag. A click
//   stages that board's URL, then switches studio: switching remounts the app (main.tsx keys
//   the router on the studio), and the fresh router boots from the URL.
// - "All projects" closes the list: the Work index, every project with its stats.
import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { LayoutList, SquareKanban } from "lucide-react";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { httpMode, STUDIO_PROJECT_ID } from "@/lib/api";
import { projects, useRegistry, workRuns, workTasks } from "@/lib/registry";
import { switchStudio, useStudio } from "@/lib/studio";
import { useStudioProjects, type GalleryFetcher, type StudioGame } from "@/lib/studio-projects";
import { summarize, waitingCount } from "@/lib/work";
import { useWeave } from "@/lib/weave-store";

const projectHref = (id: string) => `/work?project=${encodeURIComponent(id)}`;

/** Per project id: asks waiting on you, and whether any of its loops is running now. */
function useProjectSignals() {
  useRegistry(); // tasks and runs live in the registry store; re-render when they change
  const weave = useWeave();
  const tasks = workTasks(), runs = workRuns();
  return useMemo(() => {
    const out = new Map<string, { waiting: number; running: boolean }>();
    for (const task of tasks) {
      const s = summarize(task, runs, weave);
      const cur = out.get(task.projectId) ?? { waiting: 0, running: false };
      cur.waiting += waitingCount(s);
      cur.running ||= s.loops.some((r) => r.status === "running");
      out.set(task.projectId, cur);
    }
    return out;
  }, [tasks, runs, weave]);
}

/** The project a Work URL shows: ?project= on the board, or the task's project on /work/<task>. */
function useCurrentProject(): string | null | undefined {
  const { pathname, search } = useLocation();
  if (pathname === "/work") return new URLSearchParams(search).get("project");
  const task = pathname.startsWith("/work/") ? decodeURIComponent(pathname.slice("/work/".length)) : undefined;
  return task ? workTasks().find((t) => t.id === task)?.projectId : undefined;
}

const rowClass = "data-[active=true]:bg-transparent data-[active=true]:font-medium data-[active=true]:ring-1 data-[active=true]:ring-inset data-[active=true]:ring-foreground/15";

function ProjectRow({ name, href, active, waiting = 0, running = false, tag, onClick }: {
  name: string; href: string; active: boolean; waiting?: number; running?: boolean; tag?: string; onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={name} className={rowClass}>
        <Link to={href} onClick={onClick} aria-current={active ? "page" : undefined}>
          <SquareKanban />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {running && <span className="size-1.5 shrink-0 rounded-full bg-green-500" title="An agent is working on it" aria-label="running" />}
          {tag && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-foreground/75">{tag}</span>}
        </Link>
      </SidebarMenuButton>
      {waiting > 0 && (
        <SidebarMenuBadge className="bg-warn-soft text-warn peer-hover/menu-button:text-warn peer-data-active/menu-button:text-warn" aria-label={`${waiting} waiting on you`}>{waiting}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

/** The Projects section: the active studio's projects, other studios' games, then All projects. */
export function StudioProjects({ fetchGallery }: { fetchGallery?: GalleryFetcher }) {
  useRegistry();
  const { studios, studio } = useStudio();
  const signals = useProjectSignals();
  const current = useCurrentProject();
  const { pathname, search } = useLocation();
  // Single-studio mode has no selected studio; its implicit entry ("single") is the active one.
  const others = useStudioProjects(fetchGallery, studio?.id ?? "single");
  const tagged = studios.length > 1;
  // Studio-level work (Studio Head cycles, Greenlight, ops) stays on the Work index: the nav's
  // Studio item already carries its asks, and a second "Studio" row would read as the same place.
  const mine = projects().filter((p) => !p.archived && p.id !== STUDIO_PROJECT_ID);

  const openElsewhere = (game: StudioGame) => (e: React.MouseEvent) => {
    e.preventDefault();
    // Stage the board's URL first: the router remounts on the switch and boots from it.
    if (httpMode) window.history.pushState(null, "", game.slug ? projectHref(game.slug) : "/work");
    switchStudio(game.studio.id);
  };
  const onIndex = pathname === "/work" && !new URLSearchParams(search).get("project") && new URLSearchParams(search).get("view") !== "teams";

  // Rows only: the shell's section already wraps them in its SidebarMenu list.
  return (
    <>
      {mine.map((p) => {
        const sig = signals.get(p.id);
        return (
          <ProjectRow key={p.id} name={p.name} href={projectHref(p.id)} active={current === p.id}
            waiting={sig?.waiting} running={sig?.running} tag={tagged ? studio?.label : undefined} />
        );
      })}
      {others.map((g) => (
        <ProjectRow key={`${g.studio.id}:${g.slug ?? ""}`} name={g.name} href={g.slug ? projectHref(g.slug) : "/work"}
          active={false} tag={tagged ? g.studio.label : undefined} onClick={openElsewhere(g)} />
      ))}
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={onIndex} tooltip="All projects" className={`${rowClass} text-muted-foreground hover:text-foreground`}>
          <Link to="/work"><LayoutList /><span>All projects</span></Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  );
}
