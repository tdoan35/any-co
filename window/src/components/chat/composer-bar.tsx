import { createContext, useContext, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { AtSign, Check, ChevronDown, Folder, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CONNECTORS, TARGETS, type TargetId } from "@/lib/mock/options";
import { projects } from "@/lib/registry";
import { demoMode } from "@/lib/chat/demo";
import { cn } from "@/lib/utils";

// ---- Session settings: shared by the tray (before the first message) and the right sidebar (after). ----
interface SessionSettings {
  project: string | null;
  setProject: (p: string | null) => void;
  connected: Set<string>;
  toggleConnector: (id: string) => void;
  target: TargetId;
  setTarget: (t: TargetId) => void;
}
const SessionSettingsContext = createContext<SessionSettings | null>(null);

export function SessionSettingsProvider({ children }: { children: React.ReactNode }) {
  const [project, setProject] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  // D7: the demo build runs delegated work in the Sprite sandbox, and nowhere else.
  const [target, setTarget] = useState<TargetId>(demoMode ? "sprite" : "local");
  const toggleConnector = (id: string) =>
    setConnected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <SessionSettingsContext.Provider value={{ project, setProject, connected, toggleConnector, target, setTarget }}>
      {children}
    </SessionSettingsContext.Provider>
  );
}
function useSessionSettings() {
  const s = useContext(SessionSettingsContext);
  if (!s) throw new Error("useSessionSettings must be used inside SessionSettingsProvider");
  return s;
}

// ---- Context meter ----
// Mock context accounting. Replace with real usage from the run/Gateway.
const CONTEXT_LIMIT = 1_000_000;
const COMPACT_AT = 0.8;
const BASE_TOKENS = 2_140; // assistant context, matches the rest of the UI
const PER_MESSAGE = 1_800;

const fmt = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}k` : `${n}`);

export function ContextMeter({ className }: { className?: string }) {
  const messages = useAuiState((st) => st.thread.messages.length);
  const used = BASE_TOKENS + messages * PER_MESSAGE;
  const frac = Math.min(used / CONTEXT_LIMIT, 1);
  const compactAt = CONTEXT_LIMIT * COMPACT_AT;
  const left = Math.max(compactAt - used, 0);
  const pct = frac * 100;
  const hot = used >= compactAt * 0.85;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex min-w-0 flex-1 items-center gap-2 text-[10px] tabular-nums text-muted-foreground", className)} role="meter" aria-valuemin={0} aria-valuemax={CONTEXT_LIMIT} aria-valuenow={used} aria-label="Context usage">
          <span className="w-9 shrink-0 text-right">{pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span>
          <div className="relative h-1 min-w-0 flex-1 rounded-full bg-border">
            <div className={cn("absolute inset-y-0 left-0 rounded-full", hot ? "bg-warn" : "bg-foreground/50")} style={{ width: `${Math.max(pct, 0.6)}%` }} />
            <div className="absolute -top-1 h-3 w-px bg-muted-foreground/60" style={{ left: `${COMPACT_AT * 100}%` }} />
          </div>
          <span className="shrink-0">{fmt(CONTEXT_LIMIT)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="space-y-0.5 text-xs">
        <div><span className="font-medium">{fmt(used)}</span> of {fmt(CONTEXT_LIMIT)} tokens used ({pct.toFixed(1)}%)</div>
        <div>Auto-compacts at {fmt(compactAt)} · {fmt(left)} left until then</div>
      </TooltipContent>
    </Tooltip>
  );
}

// ---- Pickers (used in the tray and in the right sidebar) ----
const barButton = "h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground";

export function ProjectPicker({ className }: { className?: string }) {
  const { project, setProject } = useSessionSettings();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(barButton, className)}>
          <Folder className="size-3.5 shrink-0" /><span className="max-w-40 truncate">{project ? projects().find((p) => p.id === project)?.name : "Choose project"}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="min-w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Project</DropdownMenuLabel>
        {projects().filter((p) => !p.archived).map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => setProject(p.id)} className="justify-between">
            {p.name}{project === p.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setProject(null)} className="justify-between">
          No project{project === null && <Check className="size-3.5" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `labelClassName` lets the tray hide the label when the composer is narrow. */
export function ConnectorPicker({ className, labelClassName }: { className?: string; labelClassName?: string }) {
  const { connected, toggleConnector } = useSessionSettings();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(barButton, className)} aria-label={`Add connector${connected.size || ""}`}>
          <AtSign className="size-3.5" /><span className={labelClassName}>Add connector</span>
          {connected.size > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px] text-foreground">{connected.size}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="min-w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Connectors</DropdownMenuLabel>
        {CONNECTORS.map((c) => (
          <DropdownMenuCheckboxItem key={c.id} checked={connected.has(c.id)} onCheckedChange={() => toggleConnector(c.id)} onSelect={(e) => e.preventDefault()}>
            <Plug className="size-3.5 text-muted-foreground" />
            <span>{c.name}<span className="ml-2 text-xs text-muted-foreground">{c.note}</span></span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `withLabel` shows the target's name next to the icon (right sidebar); otherwise icon-only (tray). */
export function RunTargetPicker({ withLabel, className }: { withLabel?: boolean; className?: string }) {
  const { target, setTarget } = useSessionSettings();
  const current = TARGETS.find((t) => t.id === target)!;
  if (demoMode) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className={cn(withLabel ? cn(barButton, "inline-flex items-center rounded-md") : "inline-flex size-8 items-center justify-center text-muted-foreground", className)} aria-label={`Runs on: ${current.name} (locked)`}>
            <current.icon className="size-4" />{withLabel && <span>{current.name}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Runs on: {current.name} · locked for the demo</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size={withLabel ? "sm" : "icon"} className={cn(withLabel ? barButton : "size-8 text-muted-foreground hover:text-foreground", className)} aria-label={`Run on: ${current.name}`}>
              <current.icon />{withLabel && <><span>{current.name}</span><ChevronDown className="size-3" /></>}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Run on: {current.name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="min-w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Where should this run?</DropdownMenuLabel>
        {TARGETS.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => setTarget(t.id)} className="justify-between">
            <span className="flex items-center gap-2"><t.icon className="size-4 text-muted-foreground" />
              <span>{t.name}<span className="ml-2 text-xs text-muted-foreground">{t.note}</span></span>
            </span>
            {target === t.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerBar() {
  return (
    <div className="mx-3 -mt-3 flex items-center justify-between rounded-b-2xl border bg-muted/50 px-2 pb-1.5 pt-4">
      <div className="flex min-w-0 items-center gap-1">
        <ProjectPicker className="min-w-0" />
        <ConnectorPicker labelClassName="hidden @md/composer:inline" />
      </div>
      {/* Too short to read in a narrow composer; it moves into the toolbar once the chat starts anyway. */}
      {!demoMode && <ContextMeter className="mx-3 hidden @lg/composer:flex" />}
      <RunTargetPicker />
    </div>
  );
}
