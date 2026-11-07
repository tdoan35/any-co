import { useEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { ArrowLeft, ArrowRight, Copy, Menu, Minus, Moon, PanelLeft, Search, Settings, Square, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useTheme } from "@/hooks/use-theme";
import { desktop, type FabricDesktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { TabStrip } from "./tabs";

const noDrag = "[-webkit-app-region:no-drag]";
const control = cn("flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:outline-none", noDrag);

function BarButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled}
          className={cn("size-6 text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5", noDrag)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function AppMenu({ app }: { app: FabricDesktop["app"] }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Menu" className={cn("size-6 text-muted-foreground hover:text-foreground data-[state=open]:bg-foreground/10", noDrag)}>
          <Menu className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onSelect={() => navigate("/")}>New thread</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => app.command("reload")}>Reload</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Zoom</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {/* preventDefault keeps the menu open so zoom can be stepped. */}
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); app.command("zoom-in"); }}>Zoom in</DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); app.command("zoom-out"); }}>Zoom out</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => app.command("zoom-reset")}>Actual size</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => app.command("toggle-fullscreen")}>Toggle full screen</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => app.command("toggle-devtools")}>Developer tools</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => app.command("quit")}>Quit any-co</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Back/forward availability. React Router stores the history index in `history.state.idx`;
 * the furthest index is tracked here because the History API can't report forward entries.
 */
function useHistoryNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const type = useNavigationType();
  const idx: number = window.history.state?.idx ?? 0;
  // Updated during render when the location changes (a PUSH discards the forward entries).
  const [seen, setSeen] = useState({ key: location.key, max: idx });
  if (seen.key !== location.key) setSeen({ key: location.key, max: type === "PUSH" ? idx : Math.max(seen.max, idx) });
  return { canBack: idx > 0, canForward: idx < seen.max, back: () => navigate(-1), forward: () => navigate(1) };
}

function ThemeToggle() {
  const { dark, setTheme } = useTheme();
  return (
    <BarButton label={dark ? "Light mode" : "Dark mode"} onClick={() => setTheme(!dark)}>
      {dark ? <Sun /> : <Moon />}
    </BarButton>
  );
}

/** Window controls drawn in-app (Windows/Linux); macOS keeps its native traffic lights. */
function WindowControls({ win }: { win: FabricDesktop["window"] }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    win.isMaximized().then(setMaximized);
    return win.onMaximizedChange(setMaximized);
  }, [win]);
  return (
    <div className="flex h-full">
      <button type="button" aria-label="Minimize" onClick={win.minimize} className={control}><Minus className="size-4" /></button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} onClick={win.toggleMaximize} className={control}>
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button type="button" aria-label="Close" onClick={win.close} className={cn(control, "hover:bg-destructive hover:text-white focus-visible:bg-destructive focus-visible:text-white")}><X className="size-4" /></button>
    </div>
  );
}

/** Draggable title bar for the Electron window. Renders nothing on the web. */
export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  if (!desktop) return null;
  return <DesktopTitleBar desktop={desktop} onOpenSettings={onOpenSettings} />;
}

function DesktopTitleBar({ desktop, onOpenSettings }: { desktop: FabricDesktop; onOpenSettings: () => void }) {
  const { state, toggleSidebar } = useSidebar();
  const nav = useHistoryNav();
  const mac = desktop.platform === "darwin";
  const expanded = state === "expanded";
  // Collapsed, the section is as wide as its five 24px buttons (+ 2px gaps) and padding. Expanded, it matches the sidebar.
  const padLeft = mac ? 80 : 8;
  const collapsedWidth = padLeft + 5 * 24 + 4 * 2 + 8;
  return (
    <header className="fixed inset-x-0 top-0 z-[100] flex h-(--titlebar-height) select-none items-center justify-between border-b border-white/40 bg-sidebar/25 backdrop-blur-xl [-webkit-app-region:drag] dark:border-white/10">
      {/* Left section lines up with the sidebar below: same width and border when open, back / forward against that border. */}
      <div
        data-slot="titlebar-section"
        style={{ width: expanded ? `max(var(--sidebar-width), ${collapsedWidth}px)` : collapsedWidth }}
        className={cn("flex h-full shrink-0 items-center justify-between border-r pr-2 transition-[width,border-color] duration-200 ease-linear", expanded ? "border-white/40 dark:border-white/10" : "border-transparent")}
      >
        <div className="flex items-center gap-0.5" style={{ paddingLeft: padLeft }}>
          <AppMenu app={desktop.app} />
          <BarButton label="Toggle sidebar" onClick={toggleSidebar}><PanelLeft /></BarButton>
          <BarButton label="Search threads"><Search /></BarButton>
        </div>
        <div className="flex items-center gap-0.5">
          <BarButton label="Back" onClick={nav.back} disabled={!nav.canBack}><ArrowLeft /></BarButton>
          <BarButton label="Forward" onClick={nav.forward} disabled={!nav.canForward}><ArrowRight /></BarButton>
        </div>
      </div>
      <TabStrip />
      <div className={cn("flex h-full items-center gap-1", mac && "pr-2")}>
        <ThemeToggle />
        <BarButton label="Settings" onClick={onOpenSettings}><Settings /></BarButton>
        {!mac && <WindowControls win={desktop.window} />}
      </div>
    </header>
  );
}
