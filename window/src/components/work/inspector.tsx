import { useEffect, useRef } from "react";
import { ArrowLeft, Ban, ChevronRight } from "lucide-react";
import { policyStyle } from "@/components/chat/assistant-hero";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Face, NameRole, agentOf } from "@/components/weave/parts";
import { profileById } from "@/lib/registry";
import { fmtClock, fmtSpan, type MemberState, type MemberView, type RunView } from "@/lib/run-state";
import type { ContextSection, ContextSnapshot, Run } from "@/lib/types";
import { cn } from "@/lib/utils";

const SANDBOX: Record<string, string> = {
  jonah: "sprite/fabric-coder-7f3 · egress: package index + model host only",
};

const STATE_PILL: Record<MemberState, string> = {
  idle: "bg-foreground/5 text-muted-foreground",
  done: "bg-ok-soft text-ok",
  working: "bg-run-soft text-run",
  rework: "bg-run-soft text-run",
  bounced: "bg-warn-soft text-warn",
  waiting: "bg-warn-soft text-warn",
  blocked: "bg-foreground/5 text-muted-foreground",
};

function Terminal({ lines }: { lines: MemberView["lines"] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <div ref={ref} tabIndex={0} className="max-h-64 overflow-y-auto rounded-lg bg-[#0a0a0a] p-3 font-mono text-[11px] leading-5 text-neutral-300 focus-visible:outline-none">
      {lines.map((l, i) => <div key={i} className={l.text.startsWith("$") ? "text-neutral-100" : undefined}>{l.text}</div>)}
      <span className="animate-pulse">▍</span>
    </div>
  );
}

/** The text a context section actually contained, rebuilt from the same sources the run used (RUN-5). */
function sectionText(section: ContextSection, ctx: { agentId: string; run: Run; snap: ContextSnapshot; artifacts: RunView["artifacts"] }) {
  if (section.content !== undefined) return section.content;
  const { brief } = ctx.run;
  switch (section.label) {
    case "Soul / identity":
      return profileById(ctx.agentId).workspace.files.filter((f) => f.name !== "USER.md").map((f) => f.body.trim()).join("\n\n");
    case "Task brief":
      return [
        `Objective: ${brief.objective}`,
        `Done when:\n${brief.criteria.map((c) => `- ${c}`).join("\n")}`,
        `Constraints:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`,
        `Budget: rework ${ctx.run.reworkBudget} · ${fmtSpan(ctx.run.budget.timeS)}`,
      ].join("\n\n");
    case "Tools & policy":
      return ctx.snap.tools.map((t) => `${t.name}: ${t.policy}`).join("\n");
    case "User preferences": {
      const n = Number(/(\d+) items?/.exec(section.source)?.[1] ?? 0);
      return n ? brief.preferences.slice(0, n).map((p) => `- ${p}`).join("\n") : "None for this role. The Studio Head passes on only what the role needs.";
    }
    case "Artifact references": {
      const refs = ctx.artifacts.filter((a) => a.t <= ctx.snap.assembledAtS);
      return refs.length ? refs.map((a) => `artifact://${a.name}${a.by ? ` (from ${agentOf(a.by).name})` : ""}`).join("\n") : "No artifacts existed yet.";
    }
    case "Team knowledge":
      return section.tokens ? "- The team's workflow and done-when criteria\n- Facts and decisions from earlier loops in this project\n- Lessons this agent saved on earlier loops" : "Nothing retrieved at this step.";
    default:
      return "";
  }
}

export function Inspector({ member, run, view, t, snapshots, onClose }: {
  member: MemberView; run: Run; view: RunView; t: number; snapshots: ContextSnapshot[]; onClose: () => void;
}) {
  const a = agentOf(member.agentId);
  const snap = snapshots.filter((s) => s.agentId === member.agentId && s.assembledAtS <= t).sort((x, y) => y.assembledAtS - x.assembledAtS)[0];
  // Dana's own base context, recorded at the handoff (MEM): the "Personal memory" row shows what
  // she recalled. Specialists' snapshots never contain personal memory — theirs says notLoaded.
  const danaSnap = snapshots.find((s) => s.agentId === "dana" && s.assembledAtS <= t);
  const sandbox = snap?.sandbox ?? SANDBOX[member.agentId];
  const term = member.lines.filter((l) => l.kind === "term");
  const msgs = member.lines.filter((l) => l.kind === "msg");
  const denied = view.denied.filter((d) => d.by === member.agentId);
  const origin = profileById(member.agentId).origin;
  const pillText = member.state === "working" || member.state === "rework" ? member.currentLabel : { idle: "Idle", done: "Done", bounced: "Sent it back", waiting: "Waiting on you", blocked: "Blocked", working: "", rework: "" }[member.state];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-foreground/10 p-4 pb-3">
        <button type="button" onClick={onClose} className="-ml-1 mb-2.5 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
          <ArrowLeft className="size-3.5" />Brief
        </button>
        <div className="flex items-center gap-2.5">
          <Face id={member.agentId} size="size-9" />
          <div className="min-w-0 flex-1">
            <NameRole id={member.agentId} className="block text-sm" />
            <div className="truncate text-xs text-muted-foreground">{origin ?? "Existing agent"}{sandbox && " · Sprite sandbox"}</div>
          </div>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", STATE_PILL[member.state])}>{pillText}</span>
        </div>
      </div>
      <Tabs defaultValue="activity" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 w-fit bg-foreground/5">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="activity" className="mt-0 space-y-3">
            {sandbox && <div className="font-mono text-[11px] text-muted-foreground">{sandbox}</div>}
            {term.length > 0 && <Terminal lines={term} />}
            {msgs.length > 0 && (
              <ul className="space-y-2 text-xs">
                {msgs.map((l, i) => (
                  <li key={i} className="flex gap-2"><span className="w-14 shrink-0 font-mono tabular-nums text-muted-foreground">{fmtClock(l.t)}</span><span>{l.text}</span></li>
                ))}
              </ul>
            )}
            {member.lines.length === 0 && <p className="text-xs text-muted-foreground">Nothing yet. {a.name} hasn't started a step in this loop.</p>}
            {snap && (
              <div className="rounded-lg border border-foreground/10 bg-background/60 p-3 text-xs">
                <div className="font-medium">Context loaded · {snap.totalTokens.toLocaleString()} tokens</div>
                <div className="mt-0.5 text-muted-foreground">{snap.note}</div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="context" className="mt-0">
            {!snap ? <p className="text-xs text-muted-foreground">No context loaded yet. {a.name} assembles it when their first step starts.</p> : (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-medium">What {a.name} loaded</div>
                  <div className="text-xs text-muted-foreground">{snap.step} step · assembled at {fmtClock(snap.assembledAtS)}</div>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium tabular-nums">{snap.totalTokens.toLocaleString()} tokens</span>
                  <span className="rounded-full border border-foreground/10 px-2 py-0.5 tabular-nums text-muted-foreground">Studio Head: {run.assistantTokens.toLocaleString()} tokens</span>
                </div>
                <div className="flex h-2 gap-px overflow-hidden rounded-full bg-foreground/5">
                  {snap.sections.filter((s) => s.tokens > 0).map((s, i) => (
                    <div key={s.label} title={`${s.label} · ${s.tokens.toLocaleString()}`} style={{ width: `${(s.tokens / snap.totalTokens) * 100}%`, opacity: 1 - i * 0.14 }} className="bg-foreground" />
                  ))}
                </div>
                <ul className="divide-y divide-foreground/10 text-xs">
                  {snap.sections.map((s) => (
                    <li key={s.label}>
                      <Collapsible>
                        <CollapsibleTrigger className="group flex w-full items-center gap-2 py-2 text-left">
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                          <span className="min-w-0 flex-1"><span className="block font-medium">{s.label}</span><span className="block text-muted-foreground">{s.source}</span></span>
                          <span className={cn("font-mono tabular-nums", s.tokens === 0 && "text-muted-foreground")}>{s.tokens.toLocaleString()}</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="data-[state=closed]:animate-[collapsible-up_0.2s_ease-out] data-[state=open]:animate-[collapsible-down_0.2s_ease-out]">
                          <pre tabIndex={0} className="mb-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-foreground/5 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85 focus-visible:outline-none">
                            {sectionText(s, { agentId: member.agentId, run, snap, artifacts: view.artifacts })}
                          </pre>
                        </CollapsibleContent>
                      </Collapsible>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Not loaded:</span> {snap.notLoaded}</p>
                {danaSnap && (
                  <div className="space-y-1 border-t border-foreground/10 pt-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">Studio Head's context</span>
                      <span className="tabular-nums text-muted-foreground">{danaSnap.totalTokens.toLocaleString()} tokens</span>
                    </div>
                    <ul className="divide-y divide-foreground/10 text-xs">
                      {danaSnap.sections.map((s) => (
                        <li key={s.label} className="flex items-center gap-2 py-2">
                          <span className="min-w-0 flex-1"><span className="block font-medium">{s.label}</span><span className="block text-muted-foreground">{s.source}</span></span>
                          <span className="shrink-0 font-mono tabular-nums">{s.tokens.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="tools" className="mt-0">
            {!snap ? <p className="text-xs text-muted-foreground">No tool policy recorded yet.</p> : (
              <div className="space-y-3">
                <div className="text-sm font-medium">Tools & policy</div>
                <ul className="space-y-1.5">
                  {snap.tools.map((tool) => (
                    <li key={tool.name} className="flex items-center justify-between rounded-md border border-foreground/10 bg-background/60 px-3 py-2 font-mono text-xs">
                      {tool.name}<span className={cn("rounded-full px-2 py-0.5 font-sans text-[11px]", policyStyle[tool.policy])}>{tool.policy}</span>
                    </li>
                  ))}
                </ul>
                {denied.map((d) => (
                  <p key={d.t} className="flex gap-2 rounded-lg bg-warn-soft/60 px-3 py-2 text-xs">
                    <Ban className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    <span><span className="font-medium">Blocked at {fmtClock(d.t)}:</span> <span className="font-mono">{d.tool}</span> → {d.target} ({d.reason})</span>
                  </p>
                ))}
                <p className="text-[11px] text-muted-foreground">Policies are enforced by the runtime (the tool layer and the Sprite’s egress list), not by this view.</p>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
