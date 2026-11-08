// Studio switcher (desktop brief, goal 1): one window, two studios. Sits under the brand
// in the sidebar; switching swaps the API base for every fetch and stream and remounts the
// app (main.tsx). Labels come from VITE_STUDIOS config — never from code.
import { Check, ChevronsUpDown, Lock } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchStudio, useStudio } from "@/lib/studio";
import { cn } from "@/lib/utils";

/** A quiet "read-only" tag for mirror adapters: chat is refused there (403). */
function ReadOnlyTag({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground", className)}>
      <Lock className="size-2.5" aria-hidden />
      read-only
    </span>
  );
}

export function StudioSwitcher() {
  const { studios, studio } = useStudio();
  // Only multi-studio configs (VITE_STUDIOS, set by window/scripts/live-both.mjs) render
  // the switcher. Unset — the single-studio and mock launchers — it renders nothing, so
  // those apps look exactly as before.
  if (studios.length < 2 || !studio) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Studio: ${studio.label}. Switch studio.`}
          title={studio.readOnly ? `${studio.label} (read-only)` : studio.label}
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{studio.label}</span>
          {studio.readOnly && <ReadOnlyTag className="group-data-[collapsible=icon]:hidden" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Studio</DropdownMenuLabel>
        {studios.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => switchStudio(s.id)}>
            <Check className={cn("size-4 shrink-0", s.id !== studio.id && "opacity-0")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.readOnly && <span title="read-only"><Lock className="size-3 text-muted-foreground" aria-label="read-only" /></span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
