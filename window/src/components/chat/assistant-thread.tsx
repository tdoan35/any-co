import {
  AssistantRuntimeProvider, CompositeAttachmentAdapter, ErrorPrimitive, MessagePrimitive, SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter, ThreadPrimitive, WebSpeechDictationAdapter, useAui, useAuiState, useLocalRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Ghost, Lock, Maximize2, Monitor, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabs } from "@/components/shell/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { mockContext } from "@/lib/mock/chat";
import { httpMode } from "@/lib/api";
import { httpAssistant } from "@/lib/chat/http-assistant";
import { chatAgentContext, knownSessionId, onStreamChange, peekStream } from "@/lib/chat/session-stream";
import { fetchHistory, toRuntimePart, toRuntimeParts } from "@/lib/chat/session";
import { onSessionMessage } from "@/lib/chat/events";
import { useSessionDesktop } from "@/lib/chat/desktop";
import type { SessionDesktop } from "@/lib/chat/events";
import { currentApiBase, useStudio } from "@/lib/studio";
import { isFixtureHotkey, toggleFixture } from "@/lib/chat/fixture";
import { demoMode, liveChat } from "@/lib/chat/demo";
import { suggestionPool, type Suggestion } from "@/lib/mock/suggestions";
import { AgentHero, AgentProfilePanel, FLY, IncognitoInfo, veil, scrollArea, type SideTab, Portrait, nameLayoutId, portraitLayoutId } from "./assistant-hero";
import { chatAgents as registryChatAgents, studioTeams as registryTeams, useRegistry } from "@/lib/registry";
import type { ChatAgent, StudioTeam } from "@fabric/contracts";
import { TeamHero, TeamProfile, teamLead } from "./team-hero";
import { Composer } from "./composer";
import { ComposerBar, ConnectorPicker, ContextMeter, ProjectPicker, RunTargetPicker, SessionSettingsProvider } from "./composer-bar";
import { DispositionChip, HandoffCard, ResultsCard, SpecialistProposalCard, TeamProposalCard } from "./cards";
import { BrowserConfirmationCard, BrowserTaskStatus, RecallStatus } from "./browser-cards";

const tools = {
  by_name: {
    record_disposition: DispositionChip,
    propose_team: TeamProposalCard,
    propose_specialist: SpecialistProposalCard,
    handoff_to_team: HandoffCard,
    post_results: ResultsCard,
    browser_task: BrowserTaskStatus,
    recall: RecallStatus,
    confirm_browser: BrowserConfirmationCard,
  },
} as never;

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="py-2 text-sm leading-relaxed">
      <MessagePrimitive.Parts components={{ tools }} />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-1 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" role="alert">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

const PER_PAGE = 3;
const ROTATE_MS = 6000;
const FADE_MS = 250;

function RotatingSuggestions({ pool }: { pool: Suggestion[] }) {
  const pages = Math.ceil(pool.length / PER_PAGE);
  const [page, setPage] = useState(0);
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    let swap: ReturnType<typeof setTimeout>;
    const id = setInterval(() => {
      setVisible(false);
      swap = setTimeout(() => { setPage((p) => (p + 1) % pages); setVisible(true); }, FADE_MS);
    }, ROTATE_MS);
    return () => { clearInterval(id); clearTimeout(swap); };
  }, [paused, pages]);

  const items = pool.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  return (
    <div className="mt-4 flex w-full max-w-[960px] flex-col items-center gap-3" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className={cn("flex w-full flex-col items-center gap-2 transition-all duration-200 @2xl/main:flex-row @2xl/main:justify-center", visible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}>
        {items.map((s) => (
          <ThreadPrimitive.Suggestion key={s.label} prompt={s.prompt} send asChild>
            <Button variant="outline" size="sm" className="min-w-0 max-w-full shrink justify-start rounded-full" title={s.from ? `Based on your session: ${s.from}` : undefined}><span className="truncate">{s.label}</span></Button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
      <div className={cn("flex gap-1", pages < 2 && "invisible")} aria-hidden>
        {Array.from({ length: pages }, (_, i) => (
          <span key={i} className={cn("h-1 rounded-full transition-all", i === page ? "w-4 bg-foreground/50" : "w-1 bg-foreground/20")} />
        ))}
      </div>
    </div>
  );
}

type Target = "agent" | "team";
const CREATE_TEAM_COPY = { heading: "What kind of team do you need?", placeholder: "Describe the team you need…" };

function IconTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const swap = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
  transition: { duration: 0.2 },
};

function AgentTabs({ value, onChange, disabled }: { value: Target; onChange: (v: Target) => void; disabled?: boolean }) {
  // Hand-rolled tablist (same pattern as studio-ui's Segmented): Radix Tabs would emit
  // aria-controls for content that lives outside the tab strip, which a11y checks flag.
  return (
    <div
      role="tablist"
      className={cn(
        "relative inline-flex h-8 w-fit auto-cols-fr grid-flow-col items-center justify-center gap-0 rounded-lg bg-muted p-[3px] text-muted-foreground transition-opacity duration-300",
        disabled && "opacity-50",
      )}
    >
      <span aria-hidden className={cn(
        "pointer-events-none absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-md bg-background shadow-sm transition-transform duration-300 ease-out dark:border dark:border-input dark:bg-input/30",
        value === "team" && "translate-x-full",
      )} />
      {(["agent", "team"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={value === t}
          disabled={disabled}
          onClick={() => onChange(t)}
          className="relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-md px-5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground aria-selected:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:aria-selected:text-foreground"
        >
          {t === "agent" ? "Agents" : "Teams"}
        </button>
      ))}
    </div>
  );
}

/** After the first message: the hero portrait + name pill, flown up (same size) in place of the tabs. */
function AgentChip({ agent, team, incognito, onBackToDana, onProfileToggle }: { agent: ChatAgent; team?: StudioTeam; incognito?: boolean; onBackToDana: () => void; onProfileToggle: () => void }) {
  // The portrait switches to its working loop while a reply is in flight.
  const working = useAuiState((s) => s.thread.isRunning);
  // The pill's visible text (with the incognito suffix) must be part of the button's name.
  const pill = `${team?.name ?? agent.name}${incognito ? " · incognito" : ""}`;
  return (
    <div className="flex flex-col items-center">
      <button type="button" onClick={onProfileToggle} aria-label={`Toggle ${pill}'s profile`} className="group flex flex-col items-center rounded-full outline-none">
        <motion.div layoutId={portraitLayoutId(agent.id)} transition={FLY} className="rounded-full">
          <Portrait agent={agent} working={working} live className={cn("size-28 border-[3px] border-foreground/30 transition-[transform,filter] duration-200 group-hover:scale-105 group-hover:animate-[avatar-glow_1.8s_ease-in-out_infinite] group-focus-visible:animate-[avatar-glow_1.8s_ease-in-out_infinite]", incognito && veil)} />
        </motion.div>
        <motion.span layoutId={nameLayoutId(agent.id)} transition={FLY} className="relative z-10 -mt-3 block rounded-full border bg-card px-3 py-1 text-sm font-medium shadow-xs">
          {team?.name ?? agent.name}{incognito && " · incognito"}
        </motion.span>
      </button>
      {agent.id !== "dana" && !liveChat && (
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.45 } }} className="mt-1.5 text-xs text-muted-foreground">
          {team ? `Team chat · led by ${agent.name}` : "Direct chat"} ·{" "}
          <button type="button" onClick={onBackToDana} className="underline-offset-2 hover:text-foreground hover:underline">Back to Dana</button>
        </motion.span>
      )}
    </div>
  );
}

function TopBar({ started, value, onChange, agent, team, incognito, onBackToDana, onProfileToggle }: {
  started: boolean; value: Target; onChange: (v: Target) => void; agent: ChatAgent; team?: StudioTeam; incognito: boolean; onBackToDana: () => void; onProfileToggle: () => void;
}) {
  return (
    <div className={cn("relative flex shrink-0 justify-center", started ? "pt-4" : "h-14 items-end")}>
      <AnimatePresence mode="popLayout" initial={false}>
        {started ? (
          <motion.div key="chip">
            <AgentChip agent={agent} team={team} incognito={incognito} onBackToDana={onBackToDana} onProfileToggle={onProfileToggle} />
          </motion.div>
        ) : (
          <motion.div key="tabs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6, transition: { duration: 0.2 } }}>
            {!liveChat && <AgentTabs value={value} onChange={onChange} disabled={incognito} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Pinned to the top-right of the page (above the session panel), so opening the panel doesn't move them. */
function PageActions({ started, incognito, onIncognito, panelOpen, onPanel }: {
  started: boolean; incognito: boolean; onIncognito: () => void; panelOpen: boolean; onPanel: () => void;
}) {
  return (
    <div className="absolute right-4 top-4 z-20 flex items-center gap-1">
      {!demoMode && !liveChat && (
        <IconTip label="Start a group chat">
          <Button variant="ghost" size="icon" className="size-8" aria-label="Start a group chat"><Plus /></Button>
        </IconTip>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        {started ? (
          <motion.div key="panel" {...swap}>
            <IconTip label={panelOpen ? "Close side panel" : "Open side panel"}>
              <Button variant="ghost" size="icon" className="size-8" aria-label={panelOpen ? "Close side panel" : "Open side panel"} aria-expanded={panelOpen} onClick={onPanel}>
                {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </IconTip>
          </motion.div>
        ) : liveChat ? null : (
          <motion.div key="incognito" {...swap}>
            <IconTip label={incognito ? "Turn off incognito" : "Incognito chat"}>
              <Button variant="ghost" size="icon" role="switch" aria-checked={incognito} data-active={incognito} aria-label="Incognito chat" onClick={onIncognito}
                className="size-8 data-[active=true]:bg-foreground data-[active=true]:text-background data-[active=true]:hover:bg-foreground/90 data-[active=true]:hover:text-background">
                <Ghost />
              </Button>
            </IconTip>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A single viewer: live desktop when available, otherwise event-driven step screenshots. */
function DesktopView({ desktop, label = "Desktop" }: { desktop: SessionDesktop; label?: string }) {
  const { runId, replay, screenshotArtifactId } = desktop;
  const url = runId ? desktop.url : null;
  const live = Boolean(runId) && !replay;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">{label}</h3>
        <span className={cn("flex items-center gap-1.5 text-[11px]", live ? "text-ok" : "text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-ok" : "bg-muted-foreground/40")} />
          {runId ? replay ? "Replay" : url ? "Live" : "Running" : "Idle"}
        </span>
      </div>
      <div className="relative aspect-[16/10] overflow-hidden rounded-lg border bg-neutral-950">
        {url ? (
          <>
            <iframe src={url} title={`${label} live view`} className="absolute inset-0 size-full" allow="clipboard-read; clipboard-write" />
            <Button variant="ghost" size="icon" asChild className="absolute right-1.5 top-1.5 size-7 bg-black/40 text-white hover:bg-black/60 hover:text-white">
              <a href={url} target="_blank" rel="noreferrer" aria-label="Open desktop in a new tab"><Maximize2 className="size-3.5" /></a>
            </Button>
          </>
        ) : runId && screenshotArtifactId ? (
          <img key={screenshotArtifactId} src={`${currentApiBase()}/api/artifacts/${encodeURIComponent(screenshotArtifactId)}/screenshot`} alt={replay ? "Browser errand replay screenshot" : "Latest browser errand step"} className="absolute inset-0 size-full object-contain" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <Monitor className="size-5 text-neutral-500" />
            <div className="text-xs font-medium text-neutral-300">{runId ? "Waiting for browser view" : "No desktop session"}</div>
            <div className="text-[11px] leading-snug text-neutral-500">{runId ? "Each browser step appears here as it arrives." : "Appears here when an agent uses a computer or browser."}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Session tab of the side card: the desktop view plus the settings that lived in the tray. */
function SessionPanel({ desktop }: { desktop: SessionDesktop }) {
  const row = "flex items-center justify-between gap-3";
  return (
    <div className={cn(scrollArea, "flex flex-col gap-6 text-sm")}>
      <DesktopView desktop={desktop} />
      {!liveChat && <section className="space-y-1">
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Settings</h3>
        <div className={row}><span className="text-muted-foreground">Project</span><ProjectPicker className="-mr-2" /></div>
        <div className={row}><span className="text-muted-foreground">Connectors</span><ConnectorPicker className="-mr-2" /></div>
        <div className={row}><span className="text-muted-foreground">Runs on</span><RunTargetPicker withLabel className="-mr-2" /></div>
      </section>}
      {!demoMode && !liveChat && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Context</h3>
          <ContextMeter className="-ml-3" />
        </section>
      )}
    </div>
  );
}

/**
 * One thread: its runtime talks to Dana on the server in http mode (scripted Dana in mock mode), and
 * starts from the thread's stored history. Mount it keyed by sessionId (routes/home.tsx).
 */
export function AssistantThread({ sessionId, initialMessages, agentIndex, onAgentChange, onBackToDana }: {
  sessionId: string; initialMessages: readonly ThreadMessageLike[];
  agentIndex: number; onAgentChange: Dispatch<SetStateAction<number>>; onBackToDana: () => void;
}) {
  const [incognito, setIncognito] = useState(false);
  const adapters = useMemo(() => ({
    attachments: new CompositeAttachmentAdapter([new SimpleImageAttachmentAdapter(), new SimpleTextAttachmentAdapter()]),
    dictation: WebSpeechDictationAdapter.isSupported() ? new WebSpeechDictationAdapter() : undefined,
  }), []);
  // Incognito threads tell the server, which skips personal-memory recall (PRODUCT §10.7).
  const chatModel = useMemo(() => httpAssistant(sessionId, { incognito }), [sessionId, incognito]);
  const runtime = useLocalRuntime(chatModel, { adapters, initialMessages, unstable_humanToolNames: ["propose_team", "propose_specialist", "confirm_browser"] });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionSettingsProvider>
        <ThreadBody sessionId={sessionId} agentIndex={agentIndex} onAgentChange={onAgentChange} onBackToDana={onBackToDana}
          incognito={incognito} setIncognito={setIncognito} />
      </SessionSettingsProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * Dana's results message (CHAT-14) arrives while the thread is open: on `session.message` for this
 * session, refetch the history and append that message, unless the thread already shows it.
 */
function useLiveResults(sessionId: string) {
  const aui = useAui();
  useEffect(() => {
    if (!httpMode) return;
    return onSessionMessage((e) => {
      if (e.sessionId !== sessionId) return;
      void fetchHistory(sessionId).then((history) => {
        const message = history.find((m) => m.id === e.messageId);
        if (!message || message.role !== "assistant") return;
        const thread = aui.thread().getState();
        const shown = new Set(thread.messages.flatMap((m) => [m.id, ...m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolCallId] : []))]));
        if (shown.has(message.id) || message.content.some((p) => p.type === "tool-call" && shown.has(p.toolCallId))) return;
        void aui.thread().append({ role: "assistant", content: message.content.map(toRuntimePart) as never, startRun: false });
      }).catch((err) => console.warn("[chat] results message refresh failed", err));
    });
  }, [aui, sessionId]);
}

/**
 * Background stream updates — a turn orphaned by a remount, results, another
 * device — folded into the idle thread (a running adapter owns the thread's
 * content, so while one is in flight this does nothing). The sync is a plain
 * reset to the projection: a thread the load or a run already carried resets
 * to itself, a stale one catches up in one step, provisional growth included.
 * The count-and-tail check keeps idle threads reset-free.
 */
function useStreamResync(sessionId: string) {
  const aui = useAui();
  useEffect(() => {
    const alive = true;
    const isDelta = (id: unknown): boolean => typeof id === "string" && id.startsWith("delta:");
    const textOf = (content: readonly unknown[]): string =>
      content
        .flatMap((part) => ((part as { type?: string; text?: string })?.type === "text" ? [(part as { text?: string }).text ?? ""] : []))
        .join("");
    const apply = (): void => {
      const serverId = knownSessionId(sessionId);
      const stream = serverId ? peekStream(serverId) : undefined;
      if (!stream) return;
      void stream.ready
        .then(() => {
          if (!alive) return;
          const thread = aui.thread();
          if (thread.getState().isRunning) return; // re-checked inside the async continuation
          const shown = thread.getState().messages;
          const target = stream.state.messages;
          const shownReal = shown.filter((message) => !isDelta(message.id));
          const completed = target.filter((message) => !message.provisional);
          if (shownReal.length === completed.length) {
            // Up to date on completed messages; in sync too when the tail
            // provisional is shown and current (or there is none).
            const last = target.at(-1);
            const shownLast = shown.at(-1);
            const sameTail =
              (!last?.provisional && !isDelta(shownLast?.id)) ||
              (last?.provisional &&
                !!shownLast &&
                isDelta(shownLast.id) &&
                shownLast.id === last.id &&
                textOf(shownLast.content) === textOf(last.content));
            if (sameTail) return;
          }
          thread.reset(
            target.map((message) => ({
              id: message.id,
              role: message.role,
              content: toRuntimeParts(message.content),
              createdAt: new Date(message.createdAt),
            })),
          );
        })
        .catch(() => {});
    };
    // The backlog predates this mount (a reopen, another tab's turn): sync once
    // on the way in — a stream event alone never fires for an already-quiet log.
    apply();
    return onStreamChange(sessionId, apply);
  }, [aui, sessionId]);
}

/** Ctrl+Shift+F arms scripted Dana for the next turn (RUN-12); http mode only — mock mode is all scripted. */
function useFixtureHotkey() {
  useEffect(() => {
    if (!httpMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isFixtureHotkey(e)) return;
      e.preventDefault();
      toggleFixture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * One continuous layout for the empty screen and the conversation, so the first message can animate:
 * the portrait flies up into the top bar, the composer drops to the bottom, the tray and suggestions
 * hide, and the context meter fades into the composer toolbar.
 */
function ThreadBody({ sessionId, agentIndex, onAgentChange, onBackToDana, incognito, setIncognito }: {
  sessionId: string; agentIndex: number; onAgentChange: Dispatch<SetStateAction<number>>; onBackToDana: () => void;
  /** Owned by AssistantThread: the chat adapter reads it to skip memory recall while incognito. */
  incognito: boolean; setIncognito: Dispatch<SetStateAction<boolean>>;
}) {
  useLiveResults(sessionId);
  // Mirror studios refuse chat (the adapter 403s every POST): disable the composer up
  // front instead of letting a send fail. Read-only comes from VITE_STUDIOS config.
  const { studio: readOnlyStudio } = useStudio();
  const chatDisabled = liveChat && readOnlyStudio?.readOnly === true;
  useStreamResync(sessionId);
  useFixtureHotkey();
  const started = useAuiState((st) => !st.thread.isEmpty);
  useRegistry();
  const chatAgents = registryChatAgents();
  const studioTeams = registryTeams();
  const firstMessage = useAuiState((st) => {
    const m = st.thread.messages.find((x) => x.role === "user");
    return m ? m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ") : "";
  });
  // The tab takes the chat's title (its first message) once the chat starts, and drops it when this thread unmounts.
  const { activeId: tabId, setChatTitle } = useTabs();
  const chatTitle = firstMessage.replace(/\s+/g, " ").trim();
  useEffect(() => {
    // Incognito chats don't leak their first message into the tab.
    const title = incognito ? "Incognito chat" : (chatTitle.length > 40 ? `${chatTitle.slice(0, 40).trimEnd()}…` : chatTitle) || "New chat";
    setChatTitle(tabId, started ? title : undefined);
    return () => setChatTitle(tabId, undefined);
  }, [tabId, started, incognito, chatTitle, setChatTitle]);
  const [target, setTarget] = useState<Target>("agent");
  // Teams mode cycles your teams, plus a final "Create a team" slot (index === studioTeams.length) that hands you to Dana.
  const [teamIndex, setTeamIndex] = useState(0);
  const [sideOpen, setSideOpen] = useState(false);
  // Last-used tab, so the toggle reopens where you left off. Session is the default once a chat is running.
  const [lastTab, setLastTab] = useState<SideTab>("session");
  const desktop = useSessionDesktop(sessionId);
  // A new desktop run opens the Session tab.
  const [seenRunId, setSeenRunId] = useState<string | null>(null);
  if (desktop.runId !== seenRunId) {
    setSeenRunId(desktop.runId);
    if (desktop.runId) {
      setLastTab("session");
      setSideOpen(true);
    }
  }
  // The Session tab only exists once a chat has started.
  const sideTab: SideTab = lastTab === "session" && !started && !desktop.runId ? "agent" : lastTab;
  // Teams mode talks straight to the team's lead; the create slot talks to Dana.
  // Incognito is always Dana, off the record, so it overrides the agent and team pickers.
  const mode: Target = incognito ? "agent" : target;
  const team: StudioTeam | undefined = mode === "team" ? studioTeams[teamIndex] : undefined;
  const agent = incognito ? chatAgents[0] : mode === "agent" ? chatAgents[agentIndex] : team ? teamLead(team) : chatAgents[0];
  const copy = incognito ? { heading: agent.greeting, placeholder: `Tell ${agent.name} anything, off the record…` }
    : mode === "agent" ? { heading: agent.greeting, placeholder: agent.placeholder }
    : team ? { heading: `What should ${team.name} take on?`, placeholder: `Brief ${team.name}…` } : CREATE_TEAM_COPY;
    // Avatar: shortcut to the Agent tab (closes only if Agent is already showing).
  const toggleProfile = () => {
    if (sideOpen && sideTab === "agent") setSideOpen(false);
    else { setLastTab("agent"); setSideOpen(true); }
  };
  useEffect(() => {
    mockContext.agent = agent.name;
    // The session adapter reads the agent at run time (the chatAgentContext seam).
    chatAgentContext.id = agent.id;
  }, [agent.name, agent.id]);

  return (
    <ThreadPrimitive.Root className="@container/thread relative flex h-full min-h-0">
      {/* Below md the sidebar is an off-canvas drawer; this is its only way in. */}
      <SidebarTrigger className="absolute left-4 top-4 z-20 size-8 md:hidden" />
      <PageActions
        started={started} incognito={incognito} onIncognito={() => setIncognito((v) => !v)}
        panelOpen={sideOpen} onPanel={() => setSideOpen((v) => !v)}
      />
      {/* Main column (top bar + conversation); the session panel sits beside it at full height. */}
      <div className="@container/main flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar started={started} value={mode} onChange={setTarget} agent={agent} team={team} incognito={incognito} onBackToDana={onBackToDana} onProfileToggle={toggleProfile} />
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !started && "justify-center-safe overflow-y-auto pb-24 [@media(max-height:760px)]:pb-6")}>
          {started ? (
            <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[720px] px-4 py-6 @lg/main:px-6">
                <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
              </div>
            </ThreadPrimitive.Viewport>
          ) : (
            <div className="flex shrink-0 flex-col items-center px-4 @lg/main:px-6">
              <div key={mode} className="animate-in fade-in duration-300">
                {mode === "agent"
                  ? <AgentHero agents={chatAgents} index={incognito ? 0 : agentIndex} onIndexChange={onAgentChange} onProfileToggle={toggleProfile} switchable={!incognito} incognito={incognito} className="mb-6" />
                  : <TeamHero teams={studioTeams} index={teamIndex} onIndexChange={setTeamIndex} onProfileToggle={toggleProfile} className="mb-6" />}
              </div>
              <div className="mb-6 grid text-center text-balance">
                <h1 key={copy.heading} aria-hidden={incognito} className={cn("animate-in fade-in col-start-1 row-start-1 text-2xl font-semibold tracking-tight transition-opacity duration-300 ease-in-out", incognito && "opacity-0")}>{copy.heading}</h1>
                <h1 aria-hidden={!incognito} className={cn("col-start-1 row-start-1 text-2xl font-semibold tracking-tight transition-opacity duration-300 ease-in-out", !incognito && "opacity-0")}>Incognito chat</h1>
              </div>
              <div aria-hidden={!incognito} className={cn("grid transition-[grid-template-rows,opacity,margin] duration-300 ease-in-out", incognito ? "-mt-4 mb-6 grid-rows-[1fr] opacity-100" : "mb-0 grid-rows-[0fr] opacity-0")}>
                <p className="overflow-hidden text-center text-sm text-muted-foreground">Not saved to your sessions or used to shape your assistant.</p>
              </div>
            </div>
          )}

          <motion.div layout transition={FLY} className={cn("@container/composer mx-auto w-full max-w-[720px] shrink-0 px-4 @lg/main:px-6", started && "pb-4 pt-2")}>
            {chatDisabled ? (
              <div role="note" className="flex items-center justify-center gap-2 rounded-2xl border bg-card px-4 py-5 text-sm text-muted-foreground shadow-sm">
                <Lock className="size-4 shrink-0" aria-hidden />
                {readOnlyStudio?.label} is a read-only mirror — chat is disabled.
              </div>
            ) : (
              <Composer autoFocus placeholder={copy.placeholder} showContext={started} />
            )}
            {!started && !liveChat && <ComposerBar />}
          </motion.div>

          {!started && (
            <div className="flex shrink-0 justify-center px-4 @lg/main:px-6">
              <RotatingSuggestions key={agent.id} pool={agent.suggestions ?? suggestionPool} />
            </div>
          )}
        </div>
      </div>

      <AgentProfilePanel agent={agent} open={sideOpen} tab={sideTab} onTabChange={setLastTab} session={started || desktop.runId ? <SessionPanel desktop={desktop} /> : undefined}
        agentTab={incognito ? <IncognitoInfo agent={agent} onExit={started ? undefined : () => setIncognito(false)} /> : team ? <TeamProfile team={team} /> : undefined}
        agentTabLabel={incognito ? "Incognito" : team ? "Team" : "Agent"} onClose={() => setSideOpen(false)} />
    </ThreadPrimitive.Root>
  );
}
