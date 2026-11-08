// Flow tab: how the studio works, drawn after the README's agent setup diagram. The Studio Head
// plans every stage, Ops watches from the side, six stages hand work down (Art and Engineering run
// side by side), and every send or spend ends at a human. Inside a stage, arrows fan in and out the
// way work actually moves. Portraits follow live presence: an agent with a run in flight pulses and
// its stage lights up. Clicking an agent opens its profile in the right-hand panel.
import { Check, Hand } from "lucide-react";
import { Fragment, createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type BoardSummary } from "@/lib/api";
import { agentOf } from "@/components/weave/parts";
import { Portrait } from "@/components/chat/assistant-hero";
import { useRegistry } from "@/lib/registry";
import { useWorking } from "@/lib/presence";
import { useWeave, weaveItems } from "@/lib/weave-store";
import { cn } from "@/lib/utils";

/** One agent on the chart; `note` is its standing power in the flow (veto, only merger, ...). */
type Node = { id: string; note?: string };
/** A stage is columns of agents; work moves left to right, fanning between columns. */
type Stage = { n: number; title: string; hint: string; columns: Node[][]; aside?: Node[] };

const FALLBACK: Record<string, string> = {
  "studio-head": "Studio Head",
  "finance-compliance": "Finance & Compliance",
  "studio-historian": "Studio Historian",
  "market-analyst": "Market Analyst",
  "player-voice-analyst": "Player Voice Analyst",
  "pitch-writer": "Pitch Writer",
  "feasibility-critic": "Feasibility Critic",
  "greenlight-chair": "Greenlight Chair",
  "game-design-director": "Game Design Director",
  "level-content-designer": "Level / Content Designer",
  "ui-ux-designer": "UI / UX Designer",
  "art-director": "Art Director",
  "sprite-artist": "Sprite Artist A",
  "sprite-artist-b": "Sprite Artist B",
  "env-ui-artist": "Env / UI Artist A",
  "env-ui-artist-b": "Env / UI Artist B",
  "audio": "Audio",
  "gameplay-engineer-a": "Gameplay Engineer A",
  "gameplay-engineer-b": "Gameplay Engineer B",
  "tech-lead": "Tech Lead",
  "playtester": "Playtester",
  "qa-lead": "QA Lead",
  "build-release": "Build & Release",
  "marketing-lead": "Marketing Lead",
  "social-media-manager": "Social Media Manager",
  "community-outreach": "Community Outreach",
};

const JOB: Record<string, string> = {
  "studio-head": "Sets the schedule, budget, and scope, and writes the cards.",
  "finance-compliance": "Checks spend and the rules before anything goes out.",
  "studio-historian": "Writes the decision log.",
  "market-analyst": "Scores gaps in the Steam catalog.",
  "player-voice-analyst": "Finds what players of similar games want.",
  "pitch-writer": "Writes three pitches the studio could build.",
  "feasibility-critic": "Attacks each pitch and can veto one.",
  "greenlight-chair": "Picks the game and logs the reason.",
  "game-design-director": "Writes the design doc and the must list.",
  "level-content-designer": "Writes levels, enemies, and items as data.",
  "ui-ux-designer": "Writes the UI spec from real frames.",
  "art-director": "Locks the look and judges every asset.",
  "sprite-artist": "Draws characters and enemies.",
  "sprite-artist-b": "Draws characters and enemies.",
  "env-ui-artist": "Draws tiles, UI, and the store capsule.",
  "env-ui-artist-b": "Draws tiles, UI, and the store capsule.",
  "audio": "Makes the music and sound effects.",
  "gameplay-engineer-a": "Builds one feature track.",
  "gameplay-engineer-b": "Builds the other feature track.",
  "tech-lead": "Builds the skeleton and merges every branch.",
  "playtester": "Plays the build and reports what is confusing.",
  "qa-lead": "Runs the release gate on the build.",
  "build-release": "Exports the build and pushes it to itch.",
  "marketing-lead": "Writes the hook, store page, and trailer plan.",
  "social-media-manager": "Drafts the posts for each channel.",
  "community-outreach": "Drafts the devlog and the outreach posts.",
};

const GREENLIGHT: Stage = {
  n: 1, title: "Greenlight", hint: "Pick the game from market gaps and player reviews.",
  columns: [
    [{ id: "market-analyst" }, { id: "player-voice-analyst" }],
    [{ id: "pitch-writer" }],
    [{ id: "feasibility-critic", note: "veto" }],
    [{ id: "greenlight-chair", note: "picks" }],
  ],
};
const DESIGN: Stage = {
  n: 2, title: "Design", hint: "Turn the pick into a design doc, data, and a UI spec.",
  columns: [[{ id: "game-design-director" }], [{ id: "level-content-designer" }, { id: "ui-ux-designer" }]],
};
const ART: Stage = {
  n: 3, title: "Art and Audio", hint: "Assets against a locked style bible.",
  columns: [
    [{ id: "art-director", note: "approves every asset" }],
    [{ id: "sprite-artist" }, { id: "sprite-artist-b" }, { id: "env-ui-artist" }, { id: "env-ui-artist-b" }],
  ],
  aside: [{ id: "audio" }],
};
const ENG: Stage = {
  n: 4, title: "Engineering", hint: "Feature tracks behind a single merger.",
  columns: [[{ id: "gameplay-engineer-a" }, { id: "gameplay-engineer-b" }], [{ id: "tech-lead", note: "only merger" }]],
};
const QA: Stage = {
  n: 5, title: "QA", hint: "Every release candidate is gated.",
  columns: [[{ id: "playtester" }], [{ id: "qa-lead", note: "release gate" }]],
};
const SHIP: Stage = {
  n: 6, title: "Ship", hint: "Export, store page, and the word out.",
  columns: [[{ id: "build-release" }], [{ id: "marketing-lead" }], [{ id: "social-media-manager" }, { id: "community-outreach" }]],
};
const OPS: Node[] = [{ id: "finance-compliance" }, { id: "studio-historian" }];

/** Every agent the chart shows, in reading order (stories and tests walk this). */
export const FLOW_AGENTS: string[] = [
  "studio-head", ...OPS.map((o) => o.id),
  ...[GREENLIGHT, DESIGN, ART, ENG, QA, SHIP].flatMap((s) => [...s.columns.flat(), ...(s.aside ?? [])].map((x) => x.id)),
];

/**
 * Live registry names are derived from spec ids ("Ui Ux Designer"), so the chart's own label wins there.
 * A real persona name (mock mode, or a cast name) shows with the chart label as its role.
 */
function labelOf(id: string): { name: string; role?: string } {
  const label = FALLBACK[id] ?? id;
  const a = agentOf(id);
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const derived = a.role === "Unknown agent" || squash(a.name) === squash(id) || squash(a.name) === squash(label);
  return derived ? { name: label } : { name: a.name, role: label };
}

// ---- geometry: node rows are fixed height so connectors can be drawn in real pixels ----
const ROW = 56; // node height
const GAP = 8; // vertical gap between nodes in a column
const LINK = 36; // connector width between columns
const colHeight = (n: number) => n * ROW + (n - 1) * GAP;
const yAt = (i: number, n: number, h: number) => h / 2 + (i - (n - 1) / 2) * (ROW + GAP);

/** How many of a stage's agents have a run in flight, for its header and connectors. */
function useStageWorking(ids: string[]) {
  const { presence } = useWeave();
  return ids.filter((id) => presence.some((p) => p.agentId === id && p.state === "working")).length;
}

// ---- board progress: where the current game sits in the pipeline ----
type Counts = { todo: number; doing: number; blocked: number; done: number };
const ZERO: Counts = { todo: 0, doing: 0, blocked: 0, done: 0 };
const Board = createContext<BoardSummary | undefined>(undefined);
/** "gameplay-engineer-a" and a bare "gameplay-engineer" assignee are the same seat. */
const seat = (id: string) => id.replace(/-[ab]$/, "");
const add = (a: Counts, b: Counts): Counts => ({ todo: a.todo + b.todo, doing: a.doing + b.doing, blocked: a.blocked + b.blocked, done: a.done + b.done });
const openOf = (c: Counts) => c.todo + c.doing + c.blocked;

/** One agent's cards: its own, plus bare-seat cards for the "-a" spec. */
function agentCounts(summary: BoardSummary | undefined, id: string): Counts {
  if (!summary) return ZERO;
  const own = summary.byAssignee[id] ?? ZERO;
  const bare = id.endsWith("-a") ? summary.byAssignee[seat(id)] ?? ZERO : ZERO;
  return add(own, bare);
}
/** A stage's cards: every assignee whose seat belongs to the stage, each counted once. */
function stageCounts(summary: BoardSummary | undefined, ids: string[]): Counts {
  if (!summary) return ZERO;
  const seats = new Set(ids.map(seat));
  return Object.entries(summary.byAssignee).filter(([a]) => a && seats.has(seat(a))).reduce((n, [, c]) => add(n, c), ZERO);
}

/** Board counts, refreshed every 30 s; undefined until the first answer (or if the adapter lacks it). */
function useBoardSummary() {
  const [summary, setSummary] = useState<BoardSummary>();
  useEffect(() => {
    let stopped = false;
    const load = () => api.getBoardSummary().then((s) => { if (!stopped) setSummary(s); }).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, []);
  return summary;
}

/** Finished runs for a stage's seats (stages that ran before the board existed have runs, no cards). */
function stageRuns(summary: BoardSummary | undefined, ids: string[]): number {
  if (!summary) return 0;
  const seats = new Set(ids.map(seat));
  return Object.entries(summary.runsByAgent).filter(([a]) => seats.has(seat(a))).reduce((n, [, k]) => n + k, 0);
}

/** The stage's progress: not started, open (with blocked), or done, plus a thin bar of done / all. */
function StageProgress({ c, runs }: { c: Counts; runs: number }) {
  const total = openOf(c) + c.done;
  if (!total && runs > 0) {
    return <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok"><Check className="size-3" aria-hidden />done · {runs} {runs === 1 ? "run" : "runs"}</span>;
  }
  if (!total) return <span className="shrink-0 text-[11px] text-muted-foreground/70">not started</span>;
  const open = openOf(c);
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px]">
      {open === 0
        ? <span className="flex items-center gap-1 font-medium text-ok"><Check className="size-3" aria-hidden />done · {c.done} {c.done === 1 ? "card" : "cards"}</span>
        : (
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground/80">{open} open</span>
            {c.blocked > 0 && <span className="text-warn"> · {c.blocked} blocked</span>}
            <span> · {c.done} done</span>
          </span>
        )}
      <span aria-hidden className="h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
        <span className="block h-full rounded-full bg-ok transition-[width] duration-700" style={{ width: `${(c.done / total) * 100}%` }} />
      </span>
    </span>
  );
}

function AgentNode({ node, selected, onOpen }: { node: Node; selected?: string; onOpen?: (id: string) => void }) {
  const { id, note } = node;
  const working = useWorking(id);
  const { name, role } = labelOf(id);
  const open = openOf(agentCounts(useContext(Board), id));
  const active = selected === id;
  return (
    <button
      type="button"
      onClick={() => onOpen?.(id)}
      aria-pressed={active}
      title={JOB[id]}
      style={{ height: ROW }}
      className={cn(
        "group/node flex w-full min-w-0 items-center gap-2 rounded-xl border px-2 text-left outline-none transition-all duration-200",
        "bg-background/70 hover:-translate-y-px hover:bg-background hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-foreground/50 bg-background shadow-md" : "border-foreground/10",
        working && !active && "border-ok/50",
      )}
    >
      <Portrait agent={agentOf(id)} live className="size-9 border border-foreground/15 text-xs shadow-none" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">{name}{role && <span className="font-normal text-muted-foreground"> · {role}</span>}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {working
            ? <span className="text-ok">working now</span>
            : note ? <span className="font-medium text-foreground/70">{note}</span> : JOB[id]}
        </span>
      </span>
      {open > 0 && (
        <span title={`${open} open ${open === 1 ? "card" : "cards"} on the board`}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] px-1.5 text-[10px] font-medium tabular-nums text-foreground/70">
          {open}<span className="sr-only"> open cards</span>
        </span>
      )}
    </button>
  );
}

/** Curves from every node of one column to every node of the next, dashes flowing toward the right. */
function Fan({ from, to, h, live }: { from: number; to: number; h: number; live: boolean }) {
  const paths: string[] = [];
  for (let i = 0; i < from; i++) for (let j = 0; j < to; j++) {
    const y1 = yAt(i, from, h), y2 = yAt(j, to, h);
    paths.push(`M 0 ${y1} C ${LINK / 2} ${y1}, ${LINK / 2} ${y2}, ${LINK - 6} ${y2}`);
  }
  const heads = Array.from({ length: to }, (_, j) => yAt(j, to, h));
  return (
    <svg width={LINK} height={h} viewBox={`0 0 ${LINK} ${h}`} aria-hidden className={cn("shrink-0", live ? "text-ok" : "text-foreground/30")}
      fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d) => <path key={d} d={d} strokeDasharray="3 4" className="flow-dash" />)}
      {heads.map((y) => <path key={y} d={`M ${LINK - 10} ${y - 4} L ${LINK - 5} ${y} L ${LINK - 10} ${y + 4}`} />)}
    </svg>
  );
}

function StageCard({ stage, selected, onOpen, className }: { stage: Stage; selected?: string; onOpen?: (id: string) => void; className?: string }) {
  const all = [...stage.columns.flat(), ...(stage.aside ?? [])].map((x) => x.id);
  const working = useStageWorking(all);
  const summary = useContext(Board);
  const counts = stageCounts(summary, all);
  const runs = stageRuns(summary, all);
  const finished = (counts.done > 0 || runs > 0) && openOf(counts) === 0 && working === 0;
  const h = colHeight(Math.max(...stage.columns.map((c) => c.length)));
  return (
    <section
      aria-label={`Stage ${stage.n}: ${stage.title}`}
      className={cn(
        "@container/stage rounded-2xl border bg-card/50 p-3 shadow-sm backdrop-blur transition-colors duration-500",
        working ? "border-ok/40 bg-ok-soft/30" : finished ? "border-ok/25" : "border-foreground/10",
        className,
      )}
    >
      <header className="mb-3 flex items-baseline gap-2 px-1">
        <span className={cn("flex size-5 shrink-0 items-center justify-center self-center rounded-full text-[11px] font-semibold tabular-nums",
          finished ? "bg-ok text-background" : "bg-foreground text-background")}>
          {finished ? <Check className="size-3" aria-label="done" /> : stage.n}
        </span>
        <h3 className="text-sm font-semibold">{stage.title}</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{stage.hint}</p>
        {working > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ok">
            <span className="size-1.5 animate-pulse rounded-full bg-ok" />{working} working
          </span>
        )}
        {summary && <StageProgress c={counts} runs={runs} />}
      </header>
      <div className="flex items-center">
        {stage.columns.map((col, c) => (
          <Fragment key={c}>
            {c > 0 && <Fan from={stage.columns[c - 1]!.length} to={col.length} h={h} live={working > 0} />}
            <div className="flex min-w-0 flex-1 flex-col justify-center" style={{ height: h, gap: GAP }}>
              {col.map((node) => <AgentNode key={node.id} node={node} selected={selected} onOpen={onOpen} />)}
            </div>
          </Fragment>
        ))}
      </div>
      {stage.aside && (
        <div className="mt-2 flex items-center gap-2 border-t border-dashed border-foreground/10 pt-2">
          <span className="shrink-0 px-1 text-[11px] text-muted-foreground">alongside</span>
          {stage.aside.map((node) => <div key={node.id} className="min-w-0 flex-1"><AgentNode node={node} selected={selected} onOpen={onOpen} /></div>)}
        </div>
      )}
    </section>
  );
}

/** Art | link | Engineering. The link column is fixed so branch lines can be drawn on the same grid. */
const SPLIT = "grid @[52rem]/flow:grid-cols-[1fr_7rem_1fr]";
const bar = "absolute border-t-[1.5px] border-dashed border-foreground/35";
const pill = "rounded-full border border-foreground/10 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground";

/** A labelled downward hand-off between stages. */
function Handoff({ label, dashed, className }: { label?: string; dashed?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center text-foreground/35", className)} aria-hidden={!label}>
      <svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
        <path d="M6 0V16" strokeDasharray={dashed ? "2 3" : "3 4"} className="flow-dash-down" />
      </svg>
      {label && <span className={pill}>{label}</span>}
      <svg width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 0V16" strokeDasharray={dashed ? "2 3" : "3 4"} className="flow-dash-down" />
        <path d="M2 11 6 16.5 10 11" />
      </svg>
    </div>
  );
}

/** The one human stop. Live: how many approvals wait right now, and a way to them. */
function ApprovalGate() {
  const { status } = useWeave();
  const waiting = weaveItems().filter((i) => i.kind === "approval" && status[i.id]?.status === "open").length;
  return (
    <Link to="/weave"
      className="group mx-auto flex w-80 items-center gap-3 rounded-2xl border border-foreground/15 bg-[#b8e5cf] p-3 text-zinc-950 shadow-sm outline-none transition-transform hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring">
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white">
        <Hand className="size-4" aria-hidden />
        {waiting > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-warn ring-2 ring-[#b8e5cf]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-tight">You, at the approval gate</span>
        <span className="block text-xs leading-snug text-zinc-700">
          {waiting > 0
            ? <><span className="font-semibold text-zinc-950">{waiting} waiting on you</span> · approvals, identity, payment</>
            : "Nothing waiting. A public send or spend stops here for your yes."}
        </span>
      </span>
      <span aria-hidden className="text-xs text-zinc-700 transition-transform group-hover:translate-x-0.5">→</span>
    </Link>
  );
}

/** The studio as it works: Head on top, Ops at the side, six stages down, a human at the gate. */
export function FlowView({ onOpenAgent, selected }: { onOpenAgent?: (id: string) => void; selected?: string }) {
  useRegistry();
  const summary = useBoardSummary();
  return (
    <Board.Provider value={summary}>
    <div className="@container/flow mx-auto flex max-w-[1080px] flex-col items-stretch">
      {/* Head and Ops. Ops hangs off the Head card's right edge (out of flow when the chart is wide enough),
          so the row is exactly the Head card's height and "plans every stage" leaves from its bottom edge.
          Sized by the chart's own width (container queries), so a docked side panel never clips it. */}
      <div className="flex flex-col items-center gap-3 @[44rem]/flow:relative @[44rem]/flow:mx-auto @[44rem]/flow:block @[44rem]/flow:w-72">
        <div className="w-72 rounded-2xl border border-foreground/15 bg-card/70 p-2 shadow-sm backdrop-blur">
          <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Runs the studio</p>
          <AgentNode node={{ id: "studio-head", note: "writes the cards" }} selected={selected} onOpen={onOpenAgent} />
        </div>
        <div className="flex items-center @[44rem]/flow:absolute @[44rem]/flow:left-full @[44rem]/flow:top-1/2 @[44rem]/flow:-translate-y-1/2">
          <span aria-hidden className="hidden w-5 shrink-0 border-t-[1.5px] border-dashed border-foreground/30 @[44rem]/flow:block @[60rem]/flow:w-8" />
          <div className="w-60 rounded-2xl border border-dashed border-foreground/15 p-2 @[44rem]/flow:w-44 @[60rem]/flow:w-60">
            <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ops · watches</p>
            <div className="flex flex-col" style={{ gap: GAP }}>
              {OPS.map((o) => <AgentNode key={o.id} node={o} selected={selected} onOpen={onOpenAgent} />)}
            </div>
          </div>
        </div>
      </div>
      {/* Clears the Ops card, which hangs below the Head card's bottom edge when it sits beside it. */}
      <div aria-hidden className="mx-auto hidden h-8 border-l-[1.5px] border-dashed border-foreground/35 @[44rem]/flow:block" />

      <Handoff label="plans every stage" />
      <StageCard stage={GREENLIGHT} selected={selected} onOpen={onOpenAgent} />
      <Handoff label="the pick" />
      <StageCard stage={DESIGN} selected={selected} onOpen={onOpenAgent} className="mx-auto w-full max-w-xl" />

      {/* Design feeds both Art and Engineering. Wide: one stem from Design's center splits along a bar
          and drops onto each card's center (same grid as the cards, so the ends always land on them). */}
      <div aria-hidden className="mx-auto hidden h-3 border-l-[1.5px] border-dashed border-foreground/35 @[52rem]/flow:block" />
      <div className={cn(SPLIT, "hidden @[52rem]/flow:grid")}>
        <div className="relative flex justify-center">
          <span aria-hidden className={cn(bar, "left-1/2 right-0 top-0")} />
          <Handoff label="style bible, asset list" />
        </div>
        <div className="relative"><span aria-hidden className={cn(bar, "inset-x-0 top-0")} /></div>
        <div className="relative flex justify-center">
          <span aria-hidden className={cn(bar, "left-0 right-1/2 top-0")} />
          <Handoff label="design doc, data, UI spec" />
        </div>
      </div>
      <Handoff label="style bible, design doc, data" className="@[52rem]/flow:hidden" />

      <div className={cn(SPLIT, "grid-cols-1")}>
        <StageCard stage={ART} selected={selected} onOpen={onOpenAgent} />
        {/* Approved assets cross from Art into Engineering, edge to edge. */}
        <div className="flex flex-col items-stretch justify-center">
          <div aria-hidden className="hidden flex-col items-center gap-1 @[52rem]/flow:flex">
            <span className={pill}>approved assets</span>
            <div className="flex w-full items-center text-foreground/35">
              <span className="flex-1 border-t-[1.5px] border-dashed border-foreground/35" />
              <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="-ml-1 shrink-0">
                <path d="M1 2 7 6 1 10" />
              </svg>
            </div>
          </div>
          <Handoff label="approved assets" className="@[52rem]/flow:hidden" />
        </div>
        <StageCard stage={ENG} selected={selected} onOpen={onOpenAgent} />
      </div>

      {/* Only Engineering hands a release candidate to QA: down from its center, across to the middle, down to QA. */}
      <div aria-hidden className={cn(SPLIT, "hidden h-4 @[52rem]/flow:grid")}>
        <div />
        <div className="relative"><span className={cn(bar, "bottom-0 left-1/2 right-0")} /></div>
        <div className="relative">
          <span className="absolute inset-y-0 left-1/2 border-l-[1.5px] border-dashed border-foreground/35" />
          <span className={cn(bar, "bottom-0 left-0 right-1/2")} />
        </div>
      </div>
      <Handoff label="release candidate" />
      <StageCard stage={QA} selected={selected} onOpen={onOpenAgent} className="mx-auto w-full max-w-xl" />
      <Handoff label="PASS" />
      <StageCard stage={SHIP} selected={selected} onOpen={onOpenAgent} />
      <Handoff label="every send or spend" dashed />

      <ApprovalGate />
    </div>
    </Board.Provider>
  );
}
