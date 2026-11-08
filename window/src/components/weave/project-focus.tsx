// Weave header subtext: the project the deck describes, and a switcher for it. Live mode the
// rows are the studios' games (useStudioProjects — the sidebar's Projects list, named from the
// game repo slug); mock mode the registry's demo projects. "All projects" is the unfocused
// default whenever the current adapter carries more than the viewer's own game. The default
// focus is the current studio's game: a single-project adapter's deck *is* that project, so
// the subtext names it without the viewer choosing anything. Picking another studio's game
// switches studio through the same switchStudio() the sidebar uses, staged to stay on /weave
// (the app remounts and boots from the URL); any other pick only records ?project= — a
// single-project adapter shows the same deck either way, and the state is carried for the day
// an adapter scopes its weave data.
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { httpMode } from "@/lib/api";
import { projects, useRegistry } from "@/lib/registry";
import { switchStudio, useStudio } from "@/lib/studio";
import { useStudioProjects } from "@/lib/studio-projects";

const ALL = "all";

/** Mock rows come from the registry, so the gallery fetcher would only produce console noise. */
const noFetch = () => Promise.resolve({ repos: [] as string[] });

export function ProjectFocus() {
  const [params, setParams] = useSearchParams();
  const { studio } = useStudio();
  const games = useStudioProjects(httpMode ? undefined : noFetch);
  useRegistry(); // mock rows re-render with the store
  const currentStudioId = studio?.id ?? "single"; // the implicit single studio, like the sidebar's list
  const tagged = games.length > 1; // two studios: rows carry the studio's label, like the sidebar's folders
  const rows: Array<{ id: string; name: string; studioId?: string; tag?: string }> = httpMode
    ? games.map((g) => ({ id: g.studio.id, name: g.name, studioId: g.studio.id, tag: tagged ? g.studio.label : undefined }))
    : projects().filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name }));
  if (rows.length === 0) return null;
  const defaultId = rows.find((r) => r.studioId === currentStudioId)?.id ?? ALL;
  const selectedId = params.get("project") ?? defaultId;
  const selected = rows.find((r) => r.id === selectedId);

  const pick = (id: string) => {
    const row = rows.find((r) => r.id === id);
    // Another studio's game: switch to it, staying on /weave (staged first — the app remounts and boots from the URL).
    if (row?.studioId && row.studioId !== currentStudioId) {
      window.history.pushState(null, "", "/weave");
      switchStudio(row.studioId);
      return;
    }
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id === defaultId) n.delete("project"); // the default keeps the clean URL
      else n.set("project", id);
      return n;
    }, { replace: true });
  };
  const label = selected ? selected.name : "All projects";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label}. Change the focused project.`}
        className="flex animate-in fade-in slide-in-from-left-2 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground duration-500 fill-mode-backwards hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
      >
        {label}
        <ChevronDown className="size-3 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup value={selectedId} onValueChange={pick}>
          <DropdownMenuRadioItem value={ALL}>All projects</DropdownMenuRadioItem>
          {rows.map((r) => (
            <DropdownMenuRadioItem key={r.id} value={r.id}>
              {r.name}
              {r.tag && <span className="ml-auto pl-3 text-[10px] text-muted-foreground">{r.tag}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
