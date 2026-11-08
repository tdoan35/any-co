// Sidebar Projects section, live mode (sidebar brief): one folder per studio's game.
// - Folder names come from the studios' adapters (repo slug, title-cased — see
//   lib/studio-projects.ts); the window itself carries no game names. A studio with no
//   repo yet shows its configured label instead.
// - The active studio's folder is open, marked active, and lists its latest runs from the
//   registry store (fetched at startup). The other studios' data is not loaded, so their
//   folders only offer "Switch to view".
// - A click switches studio through the same switchStudio() the wordmark menu uses, then
//   opens the Work board: switching remounts the app (main.tsx keys the router on the
//   studio), and the fresh router boots from the URL, so the board's path is staged first.
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
  // The studio's latest loops, newest first — the few items the open folder lists.
  const runs: Run[] = active
    ? [...workRuns()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 4)
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

/** The Projects section in live mode: one folder per studio's game, in config order. */
export function StudioProjects({ fetchGallery }: { fetchGallery?: GalleryFetcher }) {
  const games = useStudioProjects(fetchGallery);
  const { studio } = useStudio();
  const navigate = useNavigate();
  // Single-studio mode has no selected studio; its one implicit entry is the active one.
  const activeId = studio?.id ?? games[0]?.studio.id;
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
      {games.map((game) => (
        <GameFolder key={game.studio.id} game={game} tagged={games.length > 1} active={game.studio.id === activeId} onOpen={openBoard} />
      ))}
    </SidebarMenu>
  );
}
