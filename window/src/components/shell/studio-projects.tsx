// Sidebar Projects section, live mode (goal 4: one studio, two projects).
// - One folder per repo the studio's adapter reports in GET /api/art-gallery `repos`
//   (see lib/studio-projects.ts); the window itself carries no game names — folder names
//   are the slug title-cased. A studio with no repo yet shows its configured label.
// - Each game folder lists that game's recent runs (`run.game === slug`). Runs without a
//   game (the Studio Head, Greenlight — or an older adapter that predates Run.game) go
//   under the studio's own folder, after the games, and only when there are any.
// - The active studio's folders are open and marked active, listing runs from the
//   registry store (fetched at startup). Other studios' data is not loaded, so their
//   folders only offer "Switch to view".
// - A click switches studio through the same switchStudio() the wordmark menu uses, then
//   opens the Work board: switching remounts the app (main.tsx keys the router on the
//   studio), and the fresh router boots from the URL, so the board's path is staged first.
// - The per-studio tag only appears when more than one studio is configured: a
//   single-studio window reads as one company (goal 4), no switcher, no tags.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, Folder, FolderOpen, SquareKanban } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { httpMode } from "@/lib/api";
import { useRegistry, workRuns } from "@/lib/registry";
import { switchStudio, useStudio, type Studio } from "@/lib/studio";
import { useStudioProjects, type GalleryFetcher, type StudioGame } from "@/lib/studio-projects";
import type { Run } from "@fabric/contracts";

function GameFolder({ game, active, tagged, onOpen }: {
  game: StudioGame; active: boolean; tagged: boolean; onOpen: (studio: Studio) => void;
}) {
  const [open, setOpen] = useState(active);
  useRegistry(); // the active folder's runs come from the store; re-render when it changes
  // This folder's latest loops, newest first — a game folder keeps only its own runs
  // (run.game === slug); the studio folder keeps the studio-level ones (game null).
  const runs: Run[] = active
    ? [...workRuns()].filter((r) => (r.game ?? null) === (game.slug ?? null)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 4)
    : [];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarMenuItem className="group/row">
        <SidebarMenuButton isActive={active} tooltip={game.name} onClick={() => onOpen(game.studio)} className="pr-14">
          {open ? <FolderOpen /> : <Folder />}
          <span className="min-w-0 flex-1 truncate text-left">{game.name}</span>
          {tagged && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{game.studio.label}</span>}
        </SidebarMenuButton>
        {/* The row click opens the board, so the chevron alone owns expand/collapse. */}
        <CollapsibleTrigger asChild>
          <button
            type="button" aria-label={`${open ? "Collapse" : "Expand"} ${game.name}`}
            className="absolute right-7 top-1.5 flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
        <SidebarMenuAction asChild showOnHover>
          <button type="button" aria-label={`${game.name} board`} title="Open the studio's board in Work" onClick={() => onOpen(game.studio)}>
            <SquareKanban />
          </button>
        </SidebarMenuAction>
        <CollapsibleContent>
          <SidebarMenuSub>
            {runs.map((run) => (
              <SidebarMenuSubItem key={run.id}>
                <SidebarMenuSubButton asChild><Link to={`/work/${run.taskId}`}><span className="line-clamp-1">{run.objective || `Loop ${run.n}`}</span></Link></SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
            {active && runs.length === 0 && (
              <SidebarMenuSubItem><span className="px-3 text-xs text-muted-foreground">No runs yet</span></SidebarMenuSubItem>
            )}
            {!active && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild>
                  <button type="button" onClick={() => onOpen(game.studio)}><span>Switch to view</span></button>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** The Projects section in live mode: one folder per game repo, per configured studio. */
export function StudioProjects({ fetchGallery }: { fetchGallery?: GalleryFetcher }) {
  const games = useStudioProjects(fetchGallery);
  const { studios, studio } = useStudio();
  useRegistry(); // the studio folder appears only once studio-level runs arrive
  const navigate = useNavigate();
  // Single-studio mode has no selected studio; its one implicit entry is the active one.
  const activeId = studio?.id ?? games[0]?.studio.id;
  // Studio-level runs need a folder of their own — unless the studio's fallback label
  // folder already plays that role (no repos reported).
  const active = games.find((g) => g.studio.id === activeId);
  const studioFolder = active?.slug && workRuns().some((r) => !r.game)
    ? { studio: active.studio, name: active.studio.label }
    : undefined;
  const folders = [...games];
  if (studioFolder) {
    let last = -1;
    folders.forEach((g, i) => { if (g.studio.id === activeId) last = i; });
    folders.splice(last + 1, 0, studioFolder);
  }
  const openBoard = (target: Studio) => {
    if (activeId !== undefined && target.id !== activeId) {
      // Stage the board's URL first: the router remounts on the switch and boots from it.
      if (httpMode) window.history.pushState(null, "", "/work");
      switchStudio(target.id);
    } else {
      navigate("/work");
    }
  };
  return (
    <SidebarMenu>
      {folders.map((game) => (
        <GameFolder key={`${game.studio.id}:${game.slug ?? ""}`} game={game} tagged={studios.length > 1} active={game.studio.id === activeId} onOpen={openBoard} />
      ))}
    </SidebarMenu>
  );
}
