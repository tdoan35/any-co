import { Link, useLocation } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Briefcase, CalendarClock, ChevronRight, Folder, FolderOpen, Gamepad2, Hammer, Archive, Moon, MoreHorizontal, Sun, Pin, PinOff, Trash2, PanelLeftClose, PanelLeftOpen, Search, Settings, Spool, SquareKanban, SquarePen } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, useSidebar,
} from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AuroraBackground } from "@/components/aurora-background";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Project, Session, SessionStatus } from "@fabric/contracts";
import { projects, sessions, studioTeams, profileById, useRegistry } from "@/lib/registry";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useTheme } from "@/hooks/use-theme";
import { desktop } from "@/lib/desktop";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { useNeedsYouCount } from "@/lib/weave-store";
import { Portrait } from "@/components/chat/assistant-hero";
import { teamLead } from "@/components/chat/team-hero";
import type { ChatAgent } from "@/lib/mock/assistant";
import { SESSION_PARAM, sessionHref } from "@/lib/chat/session";
import { httpMode } from "@/lib/api";
import { TabsProvider } from "./tabs";
import { StudioBrand } from "./studio-switcher";
import { StudioProjects } from "./studio-projects";
import { TitleBar } from "./title-bar";

const nav = [
  { href: "/", label: "New thread", icon: SquarePen, match: (p: string) => p === "/" },
  { href: "/weave", label: "Studio", icon: Spool, match: (p: string) => p.startsWith("/weave"), badge: true },
  { href: "/agents", label: "Agents", icon: Hammer, match: (p: string) => p.startsWith("/agents") },
  { href: "/schedule", label: "Schedule", icon: CalendarClock, match: (p: string) => p.startsWith("/schedule") },
  { href: "/work", label: "Work", icon: Briefcase, match: (p: string) => p.startsWith("/work") || p.startsWith("/runs") || p.startsWith("/reports") },
];

/** Asks waiting on you in Weave. Amber, never red: urgent without being loud. Collapsed, it shrinks to a dot on the icon. */
function NeedsYouBadge() {
  const count = useNeedsYouCount();
  if (!count) return null;
  return (
    <>
      <SidebarMenuBadge className="bg-warn-soft text-warn peer-hover/menu-button:text-warn peer-data-active/menu-button:text-warn" aria-label={`${count} waiting on you`}>{count}</SidebarMenuBadge>
      <span aria-hidden className="pointer-events-none absolute left-[22px] top-1.5 hidden size-1.5 rounded-full bg-warn ring-2 ring-sidebar group-data-[collapsible=icon]:block" />
    </>
  );
}

function BrandIcon() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background" role="img" aria-label="any-co game studio">
      <Gamepad2 className="size-4" />
    </span>
  );
}

const headerAction = "absolute size-7 shrink-0 transition-opacity duration-150 group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0";

function SidebarTop() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  // In Electron the title bar owns the sidebar toggle and search; the web keeps them here.
  const toggleInHeader = !desktop;
  // Both icons stay mounted and crossfade, so toggling never hard-swaps them.
  const layer = "absolute inset-0 flex items-center justify-center transition-opacity duration-150";
  return (
    <div className="relative flex h-8 items-center overflow-hidden">
      <button
        type="button"
        onClick={collapsed && toggleInHeader ? toggleSidebar : undefined}
        aria-label={collapsed && toggleInHeader ? "Open sidebar" : "any-co game studio"}
        className={cn("group relative size-8 shrink-0 rounded-lg", collapsed && toggleInHeader ? "cursor-pointer hover:bg-sidebar-accent" : "cursor-default")}
      >
        <span className={cn(layer, collapsed && toggleInHeader && "group-hover:opacity-0")}><BrandIcon /></span>
        {toggleInHeader && <span className={cn(layer, "opacity-0", collapsed && "group-hover:opacity-100")}><PanelLeftOpen className="size-4" /></span>}
      </button>
      <StudioBrand />
      {/* Anchored to the expanded width (not the animating edge) so they fade in place instead of sliding. */}
      {toggleInHeader && <>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search threads"
          className={cn("left-[calc(var(--sidebar-width)-76px)] text-muted-foreground hover:text-foreground", headerAction)}
        >
          <Search />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close sidebar"
          onClick={toggleSidebar}
          className={cn("left-[calc(var(--sidebar-width)-44px)]", headerAction)}
        >
          <PanelLeftClose />
        </Button>
      </>}
    </div>
  );
}

/** Web only: search sits in the header when the sidebar is open and in the icon rail when it's collapsed. */
function RailSearch() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  // Grows open with the collapse animation so the nav icons slide down instead of jumping.
  return (
    <SidebarMenuItem inert={!collapsed} className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-linear group-data-[collapsible=icon]:grid-rows-[1fr] group-data-[collapsible=icon]:opacity-100">
      <div className="min-h-0 overflow-hidden">
        <SidebarMenuButton tooltip="Search threads" className="text-muted-foreground hover:text-foreground">
          <Search /><span>Search threads</span>
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
  );
}

function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { dark, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="User menu" className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent">
          <Avatar className="size-6"><AvatarFallback className="text-[10px]">T</AvatarFallback></Avatar>
          <span className="flex-1 truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">Ty Thanh Doan</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-52">
        <DropdownMenuItem onSelect={onOpenSettings}><Settings className="size-4" />Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={dark ? "dark" : "light"} onValueChange={(v) => setTheme(v === "dark")}>
          <DropdownMenuRadioItem value="light"><Sun className="size-4" />Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon className="size-4" />Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsibleSection({ title, children, scroll }: { title: string; children: React.ReactNode; scroll?: "fill" | "capped" }) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  // Fade the list out where more content is hidden above/below, so it doesn't cut off hard.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !scroll) return;
    const update = () => setEdges({ top: el.scrollTop > 4, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 4 });
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [scroll, open]);
  const fade = 36;
  const mask = scroll
    ? `linear-gradient(to bottom, ${edges.top ? `transparent 0, #000 ${fade}px` : "#000 0"}, ${edges.bottom ? `#000 calc(100% - ${fade}px), transparent 100%` : "#000 100%"})`
    : undefined;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarGroup className={cn("group-data-[collapsible=icon]:hidden", scroll === "fill" && "min-h-0 flex-1")}>
        <SidebarGroupLabel asChild className="group/label cursor-pointer hover:text-foreground">
          <CollapsibleTrigger>
            {title}
            <ChevronRight className={cn("ml-1 size-3.5 opacity-0 transition group-hover/label:opacity-100 group-focus-visible/label:opacity-100", open && "rotate-90")} />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent ref={scrollRef} style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined} className={cn(scroll && "overflow-y-auto [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--border)_transparent]", scroll === "fill" && "min-h-0 flex-1", scroll === "capped" && "max-h-56")}>
          <SidebarGroupContent><SidebarMenu>{children}</SidebarMenu></SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

const STATUS: Record<SessionStatus, { ring: string; text: string; label: string }> = {
  unread: { ring: "border-green-500", text: "text-green-600 dark:text-green-400", label: "New replies" },
  input: { ring: "border-amber-400", text: "text-amber-600 dark:text-amber-400", label: "Needs your input" },
  idle: { ring: "border-transparent", text: "", label: "" },
};

/** Agent portrait with a presence ring: green for new replies, amber (pulsing) when it needs you, none otherwise. */
function ThreadAvatar({ agent, status = "idle" }: { agent: ChatAgent; status?: SessionStatus }) {
  const s = STATUS[status];
  return (
    <span className="relative shrink-0" title={s.label || undefined}>
      <span className={cn("block rounded-full border-2 p-px", s.ring)}>
        <Portrait agent={agent} className="size-6 border-0 text-xs shadow-none" />
      </span>
      {status === "input" && (
        <span aria-hidden className="absolute inset-0 rounded-full border-2 border-amber-400 animate-[dot-pulse_2.2s_ease-out_infinite] motion-reduce:hidden" />
      )}
    </span>
  );
}

/** `Dana · 3 messages`, or the state in colour when a thread needs you. */
function threadSubtitle(session: Session, who: string) {
  if (session.status === "input") return { text: `${who} · needs your input`, tone: STATUS.input.text };
  if (session.status === "unread") {
    const n = session.newReplies ?? 1;
    return { text: `${who} · ${n} new ${n === 1 ? "reply" : "replies"}`, tone: STATUS.unread.text };
  }
  return { text: `${who} · ${session.messages} ${session.messages === 1 ? "message" : "messages"}`, tone: "" };
}

function SessionRow({ session, pinned, onPin, onRemove, onOpen }: {
  session: Session; pinned: boolean; onPin: () => void; onRemove: () => void; onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const team = session.teamId ? studioTeams().find((t) => t.id === session.teamId) : undefined;
  const agent = team ? teamLead(team) : profileById(session.agentId).agent;
  const sub = threadSubtitle(session, team?.name ?? agent.name);
  return (
    <SidebarMenuItem className="group/session">
      <SidebarMenuButton asChild className={cn("h-auto gap-2.5 py-1.5 group-hover/session:pr-14 data-[menu-open=true]:pr-14", pinned && "pr-7")} data-menu-open={menuOpen}>
        <Link to={sessionHref(session)} onClick={onOpen} aria-label={`${session.title}. ${sub.text}`}>
          <ThreadAvatar agent={agent} status={session.status} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {/* Pinned rows show the pin here instead; hover and the open menu hand the corner to the actions. */}
              {!pinned && <span className="shrink-0 text-[11px] text-muted-foreground group-hover/session:hidden [[data-menu-open=true]_&]:hidden">{session.updated}</span>}
            </span>
            <span className={cn("block truncate text-xs text-muted-foreground", sub.tone)}>{sub.text}</span>
          </span>
        </Link>
      </SidebarMenuButton>
      <div className={cn(
        "absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100",
        menuOpen && "opacity-100",
      )}>
        <button type="button" onClick={onPin} aria-label={pinned ? "Unpin thread" : "Pin thread"} aria-pressed={pinned}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Thread actions"
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-40">
            <DropdownMenuItem onSelect={onPin}>{pinned ? <PinOff /> : <Pin />}{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onRemove}><Archive />Archive</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {pinned && !menuOpen && <Pin className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground group-hover/session:hidden" />}
    </SidebarMenuItem>
  );
}

function ProjectFolder({ project }: { project: Project }) {
  const [open, setOpen] = useState(project.id === "engram");
  const items = sessions().filter((x) => x.projectId === project.id);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className="group/row pr-8">
            {open ? <FolderOpen /> : <Folder />}
            <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover/row:opacity-100 group-focus-visible/row:opacity-100", open && "rotate-90")} />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <SidebarMenuAction asChild showOnHover>
          <Link to={`/work?project=${project.id}`} aria-label={`${project.name} board`} title="Open the project's board in Work"><SquareKanban /></Link>
        </SidebarMenuAction>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((x) => (
              <SidebarMenuSubItem key={x.id}>
                <SidebarMenuSubButton asChild><Link to={sessionHref(x)}><span>{x.title}</span></Link></SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

const SIDEBAR_MIN = 200, SIDEBAR_MAX = 420;

function SidebarResizeHandle({ width, onWidth, onDragging }: { width: number; onWidth: (w: number) => void; onDragging: (d: boolean) => void }) {
  const { state } = useSidebar();
  if (state === "collapsed") return null;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => onWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDragging(false);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    onDragging(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuenow={width} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(200)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onWidth(Math.max(SIDEBAR_MIN, width - 16));
        if (e.key === "ArrowRight") onWidth(Math.min(SIDEBAR_MAX, width + 16));
      }}
      className="absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-foreground/0 after:transition-colors hover:after:bg-foreground/25 focus-visible:after:bg-foreground/40 active:after:bg-foreground/40"
    />
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const registry = useRegistry();
  const { pathname, search } = useLocation();
  // The thread on screen has nothing unread.
  const openSession = pathname === "/" ? new URLSearchParams(search).get(SESSION_PARAM) : null;
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [resizing, setResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [read, setRead] = useState<Set<string>>(new Set());
  const items = registry.sessions.filter((x) => !x.projectId && !removed.has(x.id)).map((x) => (read.has(x.id) || x.id === openSession) && x.status === "unread" ? { ...x, status: "idle" as const } : x);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const togglePin = (id: string) => setPinned((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ordered = [...items.filter((x) => pinned.has(x.id)), ...items.filter((x) => !pinned.has(x.id))];
  return (
    <TooltipProvider>
    <TabsProvider>
    <AuroraBackground className="fixed inset-0 -z-10" />
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      className={cn("pt-(--titlebar-height)", resizing && "[&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none [&_[data-slot=titlebar-section]]:transition-none")}
    >
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
      <Sidebar collapsible="icon" className="top-(--titlebar-height) h-auto border-r border-white/40 dark:border-white/10 [&_[data-sidebar=sidebar]]:bg-sidebar/25 [&_[data-sidebar=sidebar]]:backdrop-blur-xl">
        <SidebarHeader className="px-2 pt-3 pb-1"><SidebarTop /></SidebarHeader>
        <SidebarContent className="overflow-hidden">
          <SidebarGroup>
            <SidebarMenu>
              {!desktop && <RailSearch />}
              {nav.filter((n) => !(httpMode && n.href === "/schedule")).map((n) => (
                <SidebarMenuItem key={n.label}>
                  <SidebarMenuButton asChild isActive={n.match(pathname)} tooltip={n.label} className="data-[active=true]:bg-transparent data-[active=true]:font-medium data-[active=true]:ring-1 data-[active=true]:ring-inset data-[active=true]:ring-foreground/15">
                    <Link to={n.href}><n.icon /><span>{n.label}</span></Link>
                  </SidebarMenuButton>
                  {n.badge && <NeedsYouBadge />}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <CollapsibleSection title="Projects" scroll="capped">
            {httpMode
              ? <StudioProjects />
              : projects().filter((p) => !p.archived).map((p) => <ProjectFolder key={p.id} project={p} />)}
          </CollapsibleSection>
          <CollapsibleSection title="Threads" scroll="fill">
            {ordered.map((x) => (
              <SessionRow key={x.id} session={x} pinned={pinned.has(x.id)} onPin={() => togglePin(x.id)} onRemove={() => setRemoved((old) => new Set(old).add(x.id))} onOpen={() => setRead((old) => new Set(old).add(x.id))} />
            ))}
          </CollapsibleSection>
        </SidebarContent>
        <SidebarFooter className="px-2 py-2"><UserMenu onOpenSettings={() => setSettingsOpen(true)} />
        </SidebarFooter>
        <SidebarResizeHandle width={sidebarWidth} onWidth={setSidebarWidth} onDragging={setResizing} />
      </Sidebar>
      <SidebarInset className="relative h-[calc(100svh-var(--titlebar-height))] overflow-hidden bg-transparent">
        <div className="relative z-10 h-full">{children}</div>
      </SidebarInset>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </SidebarProvider>
    </TabsProvider>
    </TooltipProvider>
  );
}

export function PageHeader({ children, center, right }: { children: React.ReactNode; center?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="relative flex h-12 shrink-0 items-center justify-between border-b px-6">
      <div className="flex items-center gap-2 text-sm">{children}</div>
      {center && <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">{center}</div>}
      <div className="flex items-center gap-2">{right}</div>
    </header>
  );
}
