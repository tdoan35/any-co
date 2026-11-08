import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router";
import { Briefcase, MessageSquare, Plus, Spool, SquarePen, Users, Workflow, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sessions, useRegistry } from "@/lib/registry";
import { SESSION_PARAM } from "@/lib/chat/session";

interface Tab { id: string; path: string; /** Title of the chat running in this tab, once one has started. */ chat?: string }
interface TabsState {
  tabs: Tab[]; activeId: string; select: (id: string) => void; add: () => void; close: (id: string) => void;
  setChatTitle: (id: string, title: string | undefined) => void;
}

const TabsContext = createContext<TabsState | null>(null);
export function useTabs() {
  const s = useContext(TabsContext);
  if (!s) throw new Error("useTabs must be used inside TabsProvider");
  return s;
}

let n = 0;
const newId = () => `tab-${++n}`;

/**
 * Titlebar tabs. Each tab remembers the location it was last on; the active tab follows navigation,
 * and selecting another tab navigates to its location.
 */
export function TabsProvider({ children }: { children: React.ReactNode }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: newId(), path: pathname + search }]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  // The location effect reads this, so a tab switch can't write the old location into the new tab.
  const activeRef = useRef(activeId);
  // Declared before the location effect so it runs first when both change in one commit.
  useEffect(() => { activeRef.current = activeId; }, [activeId]);

  useEffect(() => {
    setTabs((ts) => ts.map((t) => (t.id === activeRef.current ? { ...t, path: pathname + search } : t)));
  }, [pathname, search]);

  const select = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || id === activeId) return;
    setActiveId(id);
    navigate(tab.path);
  }, [tabs, activeId, navigate]);

  const add = useCallback(() => {
    const tab = { id: newId(), path: "/" };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
    navigate("/");
  }, [navigate]);

  const close = useCallback((id: string) => {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === id);
    setTabs(tabs.filter((t) => t.id !== id));
    if (id === activeId) {
      const next = tabs[i + 1] ?? tabs[i - 1];
      setActiveId(next.id);
      navigate(next.path);
    }
  }, [tabs, activeId, navigate]);

  const setChatTitle = useCallback((id: string, chat: string | undefined) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.chat !== chat ? { ...t, chat } : t)));
  }, []);

  const value = useMemo(() => ({ tabs, activeId, select, add, close, setChatTitle }), [tabs, activeId, select, add, close, setChatTitle]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

function describe(path: string): { title: string; icon: ComponentType<{ className?: string }> } {
  const [pathname, search = ""] = path.split("?");
  if (pathname === "/") {
    // A tab whose thread isn't mounted (another tab is active) is still labelled by its session.
    const session = new URLSearchParams(search).get(SESSION_PARAM);
    const title = session ? sessions().find((s) => s.id === session)?.title : undefined;
    return title ? { title, icon: MessageSquare } : { title: "New thread", icon: SquarePen };
  }
  if (pathname.startsWith("/weave")) return { title: "Studio", icon: Spool };
  if (pathname.startsWith("/agents")) {
    return new URLSearchParams(search).get("view") === "flow"
      ? { title: "Flow", icon: Workflow }
      : { title: "Teams", icon: Users };
  }
  if (pathname.startsWith("/work") || pathname.startsWith("/runs") || pathname.startsWith("/reports")) return { title: "Work", icon: Briefcase };
  return { title: "any-co", icon: SquarePen };
}

const noDrag = "[-webkit-app-region:no-drag]";

/**
 * Tab strip for the title bar's centre column, ending in a + button. A lone tab stays hidden
 * (just the +) until its chat starts, then it shows the chat's title.
 */
export function TabStrip() {
  const { tabs, activeId, select, add, close } = useTabs();
  useRegistry();
  const single = tabs.length < 2;
  const visible = single ? tabs.filter((t) => t.chat) : tabs;
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
      <div role="tablist" className="flex min-w-0 items-center gap-1">
        {visible.map((t) => {
          const described = describe(t.path);
          const title = t.chat ?? described.title;
          const Icon = t.chat ? MessageSquare : described.icon;
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => select(t.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(t.id); } }}
              onAuxClick={(e) => { if (e.button === 1) close(t.id); }}
              className={cn(
                "group/tab flex h-6 min-w-[72px] max-w-[180px] flex-1 basis-0 cursor-default items-center gap-1.5 rounded-md pl-2 pr-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                noDrag,
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {!single && (
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); close(t.id); }}
                  className="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New tab"
            onClick={add}
            className={cn("grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:outline-none", noDrag)}
          >
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">New tab</TooltipContent>
      </Tooltip>
    </div>
  );
}
