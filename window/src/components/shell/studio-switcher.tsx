// Studio switcher (desktop brief, goal 1): the "any-co" wordmark in the sidebar is the
// trigger. With more than one studio configured (VITE_STUDIOS, set by
// window/scripts/live-both.mjs) it gains a chevron and opens the studio menu; a read-only
// studio shows a small lock beside the chevron. Single-studio builds render the plain
// wordmark, exactly as before the switcher. Labels come from config — never from code.
import { Check, ChevronsUpDown, Lock } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchStudio, useStudio } from "@/lib/studio";
import { cn } from "@/lib/utils";

const wordmark = "ml-2 whitespace-nowrap text-[15px] font-semibold tracking-tight transition-opacity duration-150 group-data-[collapsible=icon]:opacity-0";

/** The studio menu. The trigger owns it; items are the configured studios. */
function StudioMenu({ children }: { children: React.ReactNode }) {
  const { studios, studio } = useStudio();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Studio</DropdownMenuLabel>
        {studios.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => switchStudio(s.id)}>
            <Check className={cn("size-4 shrink-0", s.id !== studio?.id && "opacity-0")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.readOnly && <span title="read-only"><Lock className="size-3 text-muted-foreground" aria-label="read-only" /></span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The "any-co" wordmark: plain when there is one studio, the switch menu trigger when there are more. */
export function StudioBrand() {
  const { studios, studio } = useStudio();
  if (studios.length < 2 || !studio) {
    return <span className={wordmark}>any-co</span>;
  }
  return (
    <StudioMenu>
      <button
        type="button"
        aria-label={`any-co. Studio: ${studio.label}. Switch studio.`}
        className={cn(wordmark, "flex items-center gap-1 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:pointer-events-none")}
      >
        any-co
        <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden />
        {studio.readOnly && <span title="read-only studio" className="text-muted-foreground"><Lock className="size-2.5" aria-hidden /></span>}
      </button>
    </StudioMenu>
  );
}
