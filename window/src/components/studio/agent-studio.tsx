import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Brain, Check, ChevronLeft, ChevronRight, FileText, Plug, Plus, Sparkles, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Portrait, policyStyle, ring } from "@/components/chat/assistant-hero";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { forgetMemory, useRegistry } from "@/lib/registry";
import type { StudioProfile } from "@fabric/contracts";
import { EASE, Group, SectionHead, panel, pill, surface } from "./studio-ui";

type Section = "mine" | "community";
const cardId = (id: string) => `studio-card-${id}`;
const portraitId = (id: string) => `studio-portrait-${id}`;

/**
 * Agent Studio: your profiles in a carousel, community profiles below.
 * Opening a card expands it in place and fades the other section out.
 */
export function AgentStudio({ initialId }: { initialId?: string }) {
  const registry = useRegistry();
  const [localAdds, setLocalAdds] = useState<string[]>([]);
  const mine = [...registry.agents, ...registry.communityAgents.filter((p) => localAdds.includes(p.agent.id))];
  const community = registry.communityAgents.filter((p) => !localAdds.includes(p.agent.id));
  const [sel, setSel] = useState<{ id: string; from: Section } | null>(() => {
    if (!initialId) return null;
    if (registry.agents.some((p) => p.agent.id === initialId)) return { id: initialId, from: "mine" };
    if (registry.communityAgents.some((p) => p.agent.id === initialId)) return { id: initialId, from: "community" };
    return null;
  });
  const [added, setAdded] = useState<string>();

  const selected = sel && (sel.from === "mine" ? mine : community).find((p) => p.agent.id === sel.id);
  const close = useCallback(() => setSel(null), []);
  const open = (id: string, from: Section) => { setAdded(undefined); setSel({ id, from }); };

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, close]);

  const add = (id: string) => {
    const p = community.find((c) => c.agent.id === id);
    if (!p) return;
    setLocalAdds((ids) => [...ids, p.agent.id]);
    setAdded(id);
    setSel(null);
  };

  return (
    <LayoutGroup>
      <div className="flex flex-col gap-10">
        <AnimatePresence initial={false} mode="popLayout">
          {sel?.from !== "community" && (
            <motion.section key="mine" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Agents" count={mine.length} hint="The studio's agents, defined by the specs in agents/. Each belongs to a department." />
              {selected && sel?.from === "mine"
                ? <ExpandedCard profile={selected} isDefault={selected.agent.id === mine[0].agent.id} onClose={close} />
                : <Carousel profiles={mine} focusId={added} onOpen={(id) => open(id, "mine")} />}
            </motion.section>
          )}
          {sel?.from !== "mine" && (
            <motion.section key="community" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Community profiles" count={community.length} hint="Profiles shared by others. Added agents start with an empty memory." />
              {selected && sel?.from === "community"
                ? <ExpandedCard profile={selected} onClose={close} onAdd={() => add(selected.agent.id)} />
                : community.length > 0
                  ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {community.map((p) => <CommunityCard key={p.agent.id} profile={p} onOpen={() => open(p.agent.id, "community")} onAdd={() => add(p.agent.id)} />)}
                    </div>
                  )
                  : <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">You&apos;ve added every community profile.</p>}
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

/* ── Your profiles: centered carousel ─────────────────────────────── */

function Carousel({ profiles, focusId, onOpen }: { profiles: StudioProfile[]; focusId?: string; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // A newly added profile lands at the end: bring it into view.
  useEffect(() => {
    if (!focusId) return;
    const card = ref.current?.querySelector<HTMLElement>(`[data-profile="${focusId}"]`);
    const t = setTimeout(() => card?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }), 250);
    return () => clearTimeout(t);
  }, [focusId]);

  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={measure}
        className="snap-x snap-mandatory overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage: `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black 48px, black calc(100% - 48px), ${edges.right ? "transparent" : "black"})`,
        }}
      >
        <div className="mx-auto flex w-max gap-3 px-1">
          {profiles.map((p, i) => <ProfileCard key={p.agent.id} profile={p} isDefault={i === 0} onOpen={() => onOpen(p.agent.id)} />)}
        </div>
      </div>
      <CarouselButton side="left" show={edges.left} onClick={() => page(-1)} />
      <CarouselButton side="right" show={edges.right} onClick={() => page(1)} />
    </div>
  );
}

function CarouselButton({ side, show, onClick }: { side: "left" | "right"; show: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous profiles" : "Next profiles"}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 -mt-4 grid size-8 place-items-center rounded-full bg-background/80 text-muted-foreground shadow-sm ring-1 ring-foreground/10 backdrop-blur transition-opacity hover:text-foreground",
        side === "left" ? "-left-3" : "-right-3",
        show ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ProfileCard({ profile: { agent, tagline }, isDefault, onOpen }: { profile: StudioProfile; isDefault: boolean; onOpen: () => void }) {
  return (
    <motion.button
      type="button"
      layoutId={cardId(agent.id)}
      data-profile={agent.id}
      transition={EASE}
      onClick={onOpen}
      style={{ borderRadius: 16 }}
      className={cn("group relative flex w-[196px] shrink-0 snap-center flex-col items-center px-4 pb-4 pt-5 text-center outline-none transition-colors hover:border-foreground/20 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring", surface)}
    >
      {isDefault && <span className="absolute left-3 top-3 rounded-full bg-foreground/5 px-1.5 py-px text-[10px] font-medium text-muted-foreground">Default</span>}
      <motion.div layoutId={portraitId(agent.id)} transition={EASE} className="rounded-full transition-shadow group-hover:shadow-[0_0_0_4px_color-mix(in_oklab,var(--foreground)_6%,transparent)]">
        <Portrait agent={agent} className={cn("size-20", ring)} />
      </motion.div>
      <div className="mt-3 text-sm font-semibold">{agent.name}</div>
      <div className="text-xs text-muted-foreground">{agent.role}</div>
      <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-foreground/70">{tagline}</p>
    </motion.button>
  );
}

/* ── Community ────────────────────────────────────────────────────── */

function CommunityCard({ profile: { agent, tagline, author, installs }, onOpen, onAdd }: { profile: StudioProfile; onOpen: () => void; onAdd: () => void }) {
  return (
    <motion.div layoutId={cardId(agent.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("group relative transition-colors hover:border-foreground/20 hover:bg-background/80", surface)}>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 rounded-2xl p-3 pr-11 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <motion.div layoutId={portraitId(agent.id)} transition={EASE} className="shrink-0 rounded-full">
          <Portrait agent={agent} className="size-12 border-2 border-foreground/25" />
        </motion.div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{agent.name} <span className="font-normal text-muted-foreground">{agent.role}</span></div>
          <p className="truncate text-xs text-foreground/70">{tagline}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{author} · {formatInstalls(installs ?? 0)} added</p>
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" size="icon" variant="ghost" onClick={onAdd} aria-label={`Add ${agent.name} to your agents`} className="absolute right-2 top-2 size-7 rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add to your agents</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

const formatInstalls = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/* ── Expanded profile ─────────────────────────────────────────────── */

function ExpandedCard({ profile, isDefault, onClose, onAdd }: { profile: StudioProfile; isDefault?: boolean; onClose: () => void; onAdd?: () => void }) {
  const { agent, workspace, author, origin } = profile;
  return (
    <motion.div layoutId={cardId(agent.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("overflow-hidden", surface, "bg-background/60")}>
      <div className="flex items-start gap-5 p-6 pb-5">
        <motion.div layoutId={portraitId(agent.id)} transition={EASE} className="shrink-0 rounded-full">
          <Portrait agent={agent} className={cn("size-24", ring)} />
        </motion.div>
        <motion.div className="min-w-0 flex-1 pt-1" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.3 } }}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-xl font-semibold tracking-tight">{agent.name}</h2>
            <span className="text-sm text-muted-foreground">{agent.role}</span>
            {isDefault && <span className={pill}>Default</span>}
            {author && <span className="text-xs text-muted-foreground">· by {author}</span>}
            {origin && <span className={pill}>{origin}</span>}
          </div>
          <p className="mt-1.5 max-w-[560px] text-sm leading-relaxed text-muted-foreground">{agent.summary}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.traits.map((t) => <Badge key={t} variant="secondary" className="bg-foreground/5">{t}</Badge>)}
          </div>
        </motion.div>
        <div className="flex shrink-0 items-center gap-1">
          {onAdd && <Button size="sm" className="h-8" onClick={onAdd}><Plus />Add to your agents</Button>}
          <Button size="icon" variant="ghost" className="size-8 rounded-full" onClick={onClose} aria-label="Close profile"><X /></Button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.18, duration: 0.35 } }}>
        <Tabs defaultValue="profile" className="gap-4 px-6 pb-6">
          <TabsList className="bg-foreground/5">
            <TabsTrigger value="profile"><FileText />Profile</TabsTrigger>
            <TabsTrigger value="capabilities"><Wrench />Capabilities</TabsTrigger>
            <TabsTrigger value="memory"><Brain />Memory<span className="tabular-nums text-muted-foreground">{workspace.memories.length}</span></TabsTrigger>
          </TabsList>
          <TabsContent value="profile"><FilesTab profile={profile} /></TabsContent>
          <TabsContent value="capabilities"><CapabilitiesTab profile={profile} /></TabsContent>
          <TabsContent value="memory"><MemoryTab profile={profile} /></TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
}

const tokens = (s: string) => Math.round(s.length / 4);

function FilesTab({ profile: { workspace } }: { profile: StudioProfile }) {
  const [active, setActive] = useState(workspace.files[0].name);
  const file = workspace.files.find((f) => f.name === active) ?? workspace.files[0];
  return (
    <div className="grid gap-3 md:grid-cols-[180px_1fr]">
      <ul className="flex gap-1 md:flex-col">
        {workspace.files.map((f, i) => (
          <li key={f.name}>
            <button
              type="button"
              data-active={f.name === file.name}
              onClick={() => setActive(f.name)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[active=true]:bg-foreground/5 data-[active=true]:text-foreground data-[active=true]:ring-1 data-[active=true]:ring-foreground/10"
            >
              <FileText className="size-3.5 shrink-0" />
              <span className="flex-1 font-mono">{f.name}</span>
              <span className="hidden tabular-nums text-[10px] text-muted-foreground md:inline">{i + 1}</span>
            </button>
          </li>
        ))}
        <li className="mt-auto hidden px-2.5 pt-3 text-[11px] leading-4 text-muted-foreground md:block">Loaded in this order at the start of every run.</li>
      </ul>
      <div className={cn(panel, "min-w-0 overflow-hidden")}>
        <div className="flex items-center justify-between border-b border-foreground/10 px-3 py-2 text-xs">
          <span className="font-mono">{file.name}</span>
          <span className="tabular-nums text-muted-foreground">~{tokens(file.body).toLocaleString()} tokens</span>
        </div>
        <MarkdownSource body={file.body} />
      </div>
    </div>
  );
}

/** Raw markdown with the syntax dimmed, so you inspect exactly what the agent loads. */
function MarkdownSource({ body }: { body: string }) {
  const lines = body.trimEnd().split("\n");
  return (
    <div className="max-h-[440px] overflow-auto py-2 font-mono text-xs leading-5">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-9 shrink-0 select-none pr-3 text-right tabular-nums text-muted-foreground/50">{i + 1}</span>
          <span className="min-w-0 whitespace-pre-wrap pr-4">{renderLine(line)}</span>
        </div>
      ))}
    </div>
  );
}

function renderLine(line: string) {
  const heading = /^(#{1,6} )(.*)$/.exec(line);
  if (heading) return <><span className="text-muted-foreground/60">{heading[1]}</span><span className="font-semibold">{heading[2]}</span></>;
  const bullet = /^(\s*- )(.*)$/.exec(line);
  if (bullet) return <><span className="text-muted-foreground/60">{bullet[1]}</span>{renderBold(bullet[2])}</>;
  return renderBold(line) ;
}

function renderBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <Fragment key={i}><span className="text-muted-foreground/60">**</span><span className="font-semibold">{part.slice(2, -2)}</span><span className="text-muted-foreground/60">**</span></Fragment>
      : <Fragment key={i}>{part}</Fragment>,
  );
}

function CapabilitiesTab({ profile: { agent, workspace } }: { profile: StudioProfile }) {
  return (
    <div className="grid gap-5">
      <Group icon={Sparkles} title="Skills" count={workspace.skills.length}>
        <div className="grid gap-2 sm:grid-cols-2">
          {workspace.skills.map((s) => (
            <div key={s.name} className={cn(panel, "px-3 py-2.5")}>
              <div className="font-mono text-xs">{s.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
            </div>
          ))}
        </div>
      </Group>
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
    </div>
  );
}

function MemoryTab({ profile: { agent, workspace } }: { profile: StudioProfile }) {
  return (
    <div className="grid gap-5 md:grid-cols-[1fr_240px]">
      <Group icon={Brain} title="Memories" count={workspace.memories.length}>
        {workspace.memories.length > 0 ? (
          <ul className={cn(panel, "divide-y divide-foreground/10")}>
            {workspace.memories.map((m) => (
              <li key={m.id ?? m.text} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm leading-snug">{m.text}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{m.source} · {m.when}</p>
                </div>
                {/* Real rows (the Mnemosyne import) can be forgotten; seeded JSON stays read-only. */}
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
          <p className="rounded-xl border border-dashed border-foreground/15 px-4 py-6 text-center text-xs text-muted-foreground">No memories yet. {agent.name} starts remembering once you add them.</p>
        )}
      </Group>
      <Group title="Scope">
        <dl className={cn(panel, "space-y-2 px-3 py-2.5 text-xs")}>
          {agent.memory.map((m) => (
            <div key={m.label}><dt className="text-muted-foreground">{m.label}</dt><dd>{m.value}</dd></div>
          ))}
          <div><dt className="text-muted-foreground">Typical context</dt><dd className="tabular-nums">{agent.contextTokens.toLocaleString()} tokens</dd></div>
        </dl>
      </Group>
    </div>
  );
}
