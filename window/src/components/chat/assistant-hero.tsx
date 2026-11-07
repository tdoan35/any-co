import { Link } from "react-router";
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ArrowLeftRight, ArrowUpRight, Brain, Check, ChevronLeft, ChevronRight, FileText, Plug, Sparkles, Wrench, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { AgentAvatar, InitialAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Group, panel } from "@/components/studio/studio-ui";
import { forgetMemory, myProfiles } from "@/lib/registry";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ChatAgent } from "@/lib/mock/assistant";
import { cn } from "@/lib/utils";

export const policyStyle = {
  allowed: "bg-ok-soft text-ok",
  approval: "bg-warn-soft text-warn",
  blocked: "bg-destructive/10 text-destructive",
} as const;

/** Portrait for any chat agent: animated sprite when it has art, initial circle otherwise. */
export function Portrait({ agent, working, className }: { agent: ChatAgent; working?: boolean; className?: string }) {
  return agent.avatar
    ? <AgentAvatar avatar={agent.avatar} name={agent.name} working={working} className={className} />
    : <InitialAvatar initial={agent.name[0]} name={agent.name} tone={agent.tone} className={cn("text-4xl", className)} />;
}

export const ring = "border-[3px] border-foreground/30";

/** Incognito treatment for a portrait: desaturated, dimmed, dashed ring.  */
export const veil = "grayscale brightness-90 border-dashed";

/** Shared timing for the hero → top bar flight (portrait) and the composer drop. */
export const FLY = { duration: 0.55, ease: [0.22, 1, 0.36, 1] } as const;
export const portraitLayoutId = (agentId: string) => `portrait-${agentId}`;
export const nameLayoutId = (agentId: string) => `name-${agentId}`;

export function ChevronButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      onClick={onClick}
      className={cn(
        // Centred with a margin, not translate: Button's press nudge also uses translate and would override it.
        // 3.5rem = avatar centre; 1.125rem = role pill (h-6) minus its -mb-1.5 overlap with the avatar.
        "absolute top-[calc(3.5rem+1.125rem)] -mt-[18px] size-9 rounded-full bg-card/70 opacity-0 backdrop-blur transition-opacity duration-150",
        "group-hover/hero:opacity-100 group-focus-within/hero:opacity-100 focus-visible:opacity-100",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon />
    </Button>
  );
}

/**
 * Hero for the empty chat: portrait + name pill. Hovering the area reveals chevrons to cycle agents,
 * and the name pill opens a jump-to-anyone list. Clicking the portrait opens the agent's profile.
 */
export function AgentHero({ agents, index, onIndexChange, onProfileToggle, switchable = true, incognito, className }: {
  agents: ChatAgent[]; index: number; onIndexChange: Dispatch<SetStateAction<number>>; onProfileToggle: () => void; switchable?: boolean; incognito?: boolean; className?: string;
}) {
  const agent = agents[index];
  const [dir, setDir] = useState<1 | -1>(1);
  const canSwitch = switchable && agents.length > 1;
  // The pill's visible text (with the incognito suffix) must be part of the button's name.
  const pill = `${agent.name}${incognito ? " · incognito" : ""}`;

  const jump = (i: number) => { setDir(i > index ? 1 : -1); onIndexChange(i); };
  // Functional update: rapid clicks each step from the latest index instead of a stale one.
  const step = (d: 1 | -1) => { setDir(d); onIndexChange((i) => (i + d + agents.length) % agents.length); };

  return (
    <div
      className={cn("group/hero relative flex w-80 flex-col items-center py-1", className)}
      onKeyDown={(e) => {
        if (!canSwitch || e.target !== e.currentTarget.querySelector("[data-portrait]")) return;
        if (e.key === "ArrowLeft") step(-1);
        if (e.key === "ArrowRight") step(1);
      }}
    >
      {canSwitch && <ChevronButton side="left" label="Previous agent" onClick={() => step(-1)} />}
      {canSwitch && <ChevronButton side="right" label="Next agent" onClick={() => step(1)} />}

      <div key={agent.id} className={cn("flex flex-col items-center animate-in fade-in-0 duration-200", dir > 0 ? "slide-in-from-right-3" : "slide-in-from-left-3")}>
        <span className="relative z-0 -mb-1.5 inline-flex -translate-y-[3px] h-6 items-center rounded-full border bg-card/60 px-2.5 opacity-0 transition-opacity duration-150 group-hover/hero:opacity-100 group-focus-within/hero:opacity-100 text-xs font-medium capitalize text-muted-foreground shadow-xs">{agent.role}</span>
        <button
          type="button"
          data-portrait
          onClick={onProfileToggle}
          aria-label={`Toggle ${pill}'s profile`}
          className="group relative z-10 rounded-full outline-none"
        >
          <motion.div layoutId={portraitLayoutId(agent.id)} transition={FLY} className="rounded-full">
            <Portrait
              agent={agent}
              className={cn("relative size-28 cursor-pointer transition-[transform,filter] duration-300 group-hover:scale-105 group-hover:animate-[avatar-glow_1.8s_ease-in-out_infinite] group-focus-visible:animate-[avatar-glow_1.8s_ease-in-out_infinite] group-focus-visible:border-foreground/60", ring, incognito && veil)}
            />
          </motion.div>
        </button>

        <div className="relative z-10 -mt-3">
          <motion.span layoutId={nameLayoutId(agent.id)} transition={FLY} className="block rounded-full border bg-card px-3 py-1 text-sm font-medium shadow-xs">{agent.name}{incognito && " · incognito"}</motion.span>
          {canSwitch && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Switch agent (now ${agent.name})`}
                  className={cn(
                    "absolute left-full top-1/2 -mt-3.5 ml-1.5 size-7 rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground",
                    "group-hover/hero:opacity-100 group-focus-within/hero:opacity-100 data-[state=open]:opacity-100",
                  )}
                >
                  <ArrowLeftRight className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-64">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Talk to</DropdownMenuLabel>
                {agents.map((a, i) => (
                  <DropdownMenuItem key={a.id} onSelect={() => jump(i)} className="gap-2.5">
                    <Portrait agent={a} className="size-7 border-0 text-xs shadow-none" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm">
                        {a.name}
                        {i === 0 && <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">Default</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{a.role}</span>
                    </span>
                    {i === index && <Check className="size-3.5 shrink-0" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {canSwitch && (
        <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/hero:opacity-100 group-focus-within/hero:opacity-100">
          <span className="sr-only">{`Agent ${index + 1} of ${agents.length}`}</span>
          {agents.map((a, i) => (
            <span key={a.id} className={cn("h-1 rounded-full transition-all", i === index ? "w-4 bg-foreground/50" : "w-1 bg-foreground/20")} />
          ))}
        </div>
      )}

    </div>
  );
}

export type SideTab = "agent" | "session";

/**
 * Right-hand card. Not modal: the page reflows beside it and stays usable. Width opens first so the
 * main column makes room while the card itself slides in from the edge. Tabs above the card switch
 * between the agent's profile and (once a chat has started) the session info passed as `session`.
 */
export function AgentProfilePanel({ agent, open, tab, onTabChange, session, agentTab, agentTabLabel = "Agent", onClose }: {
  agent: ChatAgent; open: boolean; tab: SideTab; onTabChange: (t: SideTab) => void; session?: ReactNode;
  /** Replaces the agent profile (e.g. a team profile in Teams mode). */
  agentTab?: ReactNode; agentTabLabel?: string; onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const SLOT = 376; // card width (360) + 16px right gutter
  // Explicit tab/tabpanel wiring: the panel's content area is an animated container, not a
  // Radix TabsContent, so the trigger ↔ panel linkage is wired by hand and a11y-checkable.
  const panelTabs = (["agent", ...(session ? (["session"] as const) : [])]) as SideTab[];
  const panelTabId = (t: SideTab) => `agent-panel-tab-${t}`;
  const panelContentId = (t: SideTab) => `agent-panel-content-${t}`;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="agent-profile"
          aria-label={`${agent.name}'s profile`}
          initial={{ width: 0 }}
          animate={{ width: SLOT }}
          exit={{ width: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          // Below @4xl there's no room to reflow, so it floats over the page instead. Top clears the pinned page actions.
          className="absolute inset-y-0 right-0 z-10 flex shrink-0 justify-end overflow-hidden pb-4 pt-[3.75rem] @4xl/thread:relative"
        >
          <motion.div
            initial={{ x: SLOT }} animate={{ x: 0 }} exit={{ x: SLOT }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="mr-4 flex min-h-0 w-[360px] shrink-0 flex-col"
          >
            <div className="min-h-0 flex-1">
              <div className="group/card relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg">
                <div className="flex shrink-0 items-center justify-between px-3 pt-3">
                  <div role="tablist" className="relative grid auto-cols-fr grid-flow-col">
                    {/* Sliding highlight, same treatment as the Agents / Teams switch. */}
                    <span aria-hidden className="pointer-events-none absolute inset-y-[3px] left-[3px] rounded-md bg-background shadow-sm transition-transform duration-300 ease-out dark:border dark:border-input dark:bg-input/30"
                      style={{ width: `calc((100% - 6px) / ${session ? 2 : 1})`, transform: `translateX(${tab === "session" && session ? 100 : 0}%)` }} />
                    {panelTabs.map((t) => (
                      <button key={t} type="button" role="tab" id={panelTabId(t)} aria-selected={tab === t} aria-controls={panelContentId(t)}
                        onClick={() => onTabChange(t)}
                        className="relative z-10 inline-flex items-center justify-center rounded-md px-4 py-0.5 text-sm font-medium capitalize whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground aria-selected:text-foreground dark:text-muted-foreground dark:aria-selected:text-foreground">{t === "agent" ? agentTabLabel : t}</button>
                    ))}
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label="Close panel" onClick={onClose} className="size-7 text-muted-foreground opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/card:opacity-100">
                    <X className="size-4" />
                  </Button>
                </div>
                {/* Directional slide + fade: Session enters from the right, Agent from the left. */}
                <AnimatePresence mode="wait" initial={false} custom={tab === "session" ? 1 : -1}>
                  <motion.div
                    key={tab}
                    role="tabpanel"
                    id={panelContentId(tab)}
                    aria-labelledby={panelTabId(tab)}
                    custom={tab === "session" ? 1 : -1}
                    variants={{
                      enter: (d: number) => ({ opacity: 0, x: 16 * d }),
                      center: { opacity: 1, x: 0 },
                      exit: (d: number) => ({ opacity: 0, x: -16 * d }),
                    }}
                    initial="enter" animate="center" exit="exit"
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    {tab === "session" && session ? session : (agentTab ?? <ProfileTabs agent={agent} />)}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

export const scrollArea = "min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--color-border)_transparent]";

/** Same Profile / Capabilities / Memory split as Agent Studio, condensed to a single column. */
function ProfileTabs({ agent }: { agent: ChatAgent }) {
  const profile = myProfiles().find((p) => p.agent.id === agent.id);
  const workspace = profile?.workspace;
  return (
    <Tabs key={agent.id} defaultValue="profile" className="min-h-0 flex-1 gap-0">
      <header className="flex shrink-0 flex-col items-center gap-3 p-6 pb-4 pt-4 text-center">
        <Portrait agent={agent} className={cn("size-24", ring)} />
        <div>
          <h2 className="text-lg font-semibold leading-none">{agent.name}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">{agent.role}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {agent.traits.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
        </div>
      </header>
      <div className="shrink-0 border-b px-4 pb-3">
        <TabsList className="w-full bg-foreground/5">
          <TabsTrigger value="profile" className="flex-1"><FileText />Profile</TabsTrigger>
          <TabsTrigger value="capabilities" className="flex-1"><Wrench />Capabilities</TabsTrigger>
          <TabsTrigger value="memory" className="flex-1"><Brain />Memory{workspace && <span className="tabular-nums text-muted-foreground">{workspace.memories.length}</span>}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="profile" className={cn(scrollArea, "space-y-5 text-sm")}>
        <Group title="About"><p className="leading-relaxed">{agent.summary}</p></Group>
        <Group title="Personality"><p className="leading-relaxed">{agent.personality}</p></Group>
        {workspace && (
          <Group icon={FileText} title="Workspace files" count={workspace.files.length}>
            <ul className={cn(panel, "divide-y divide-foreground/10")}>
              {workspace.files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="font-mono">{f.name}</span>
                  <span className="tabular-nums text-muted-foreground">~{Math.round(f.body.length / 4).toLocaleString()} tokens</span>
                </li>
              ))}
            </ul>
          </Group>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents?agent=${agent.id}`}>Edit in Agent Studio <ArrowUpRight /></Link>
        </Button>
      </TabsContent>

      <TabsContent value="capabilities" className={cn(scrollArea, "space-y-5")}>
        {workspace && (
          <Group icon={Sparkles} title="Skills" count={workspace.skills.length}>
            <div className="space-y-2">
              {workspace.skills.map((sk) => (
                <div key={sk.name} className={cn(panel, "px-3 py-2.5")}>
                  <div className="font-mono text-xs">{sk.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{sk.description}</div>
                </div>
              ))}
            </div>
          </Group>
        )}
        <Group icon={Wrench} title="Tools" count={agent.tools.length}>
          <ul className={cn(panel, "divide-y divide-foreground/10")}>
            {agent.tools.map((t) => (
              <li key={t.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0"><div className="font-mono text-xs">{t.name}</div><div className="truncate text-xs text-muted-foreground">{t.note}</div></div>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px]", policyStyle[t.policy])}>{t.policy}</span>
              </li>
            ))}
          </ul>
        </Group>
        {workspace && (
          <Group icon={Plug} title="Connectors" count={workspace.connectors.length}>
            <ul className={cn(panel, "divide-y divide-foreground/10")}>
              {workspace.connectors.map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0"><div className="text-xs font-medium">{c.name}</div><div className="truncate text-xs text-muted-foreground">{c.note}</div></div>
                  {c.status === "connected"
                    ? <span className="flex shrink-0 items-center gap-1 text-[11px] text-ok"><Check className="size-3" />Connected</span>
                    : <span className="shrink-0 text-[11px] text-muted-foreground">Available</span>}
                </li>
              ))}
            </ul>
          </Group>
        )}
      </TabsContent>

      <TabsContent value="memory" className={cn(scrollArea, "space-y-5")}>
        {workspace && (
          <Group icon={Brain} title="Memories" count={workspace.memories.length}>
            {workspace.memories.length > 0 ? (
              <ul className={cn(panel, "divide-y divide-foreground/10")}>
                {workspace.memories.map((m) => (
                  <li key={m.id ?? m.text} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm leading-snug">{m.text}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{m.source} · {m.when}</p>
                    </div>
                    {m.id && (
                      <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => forgetMemory(agent.id, m.id!)}>
                        Forget
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">No memories yet.</p>
            )}
          </Group>
        )}
        <Group title="Scope">
          <dl className={cn(panel, "space-y-2 px-3 py-2.5 text-xs")}>
            {agent.memory.map((m) => <div key={m.label}><dt className="text-muted-foreground">{m.label}</dt><dd>{m.value}</dd></div>)}
            <div><dt className="text-muted-foreground">Typical context</dt><dd className="tabular-nums">{agent.contextTokens.toLocaleString()} tokens</dd></div>
          </dl>
        </Group>
      </TabsContent>
    </Tabs>
  );
}

/** Stand-in for the agent profile while incognito: what isn't kept, and a way out. */
export function IncognitoInfo({ agent, onExit }: { agent: ChatAgent; onExit?: () => void }) {
  const items = [
    { title: "Not saved", body: "This thread won't appear in your Threads list or search." },
    { title: "Memory off", body: `${agent.name} won't read your personal memory or add to it.` },
    { title: "Not used to shape your assistant", body: "Nothing here feeds suggestions or preferences." },
  ];
  return (
    <div className={cn(scrollArea, "space-y-5 text-sm")}>
      <header className="flex flex-col items-center gap-3 pt-2 text-center">
        <Portrait agent={agent} className={cn("size-24", ring, veil)} />
        <div>
          <h2 className="text-lg font-semibold leading-none">Incognito chat</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">{agent.name}, off the record</p>
        </div>
      </header>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.title} className="rounded-xl border border-foreground/10 bg-background/50 px-3 py-2.5">
            <div className="text-sm font-medium">{i.title}</div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{i.body}</p>
          </li>
        ))}
      </ul>
      {onExit && <Button variant="outline" size="sm" onClick={onExit}>Turn off incognito</Button>}
    </div>
  );
}
