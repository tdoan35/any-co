import { Link } from "react-router";
import { useAui, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowDown, ArrowRight, Check, ChevronRight, CircleCheck, CornerDownLeft, LoaderCircle, Mail, Rocket, Users, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar, InitialAvatar } from "@/components/agent-avatar";
import { registry, useRegistry } from "@/lib/registry";
import { cn } from "@/lib/utils";
import type { Disposition, HandoffPayload, ProposalDecision, ProposalRow, ResultsPayload, SpecialistProposal, TeamProposal } from "@/lib/types";

const DISPOSITION_LABEL: Record<Disposition, string> = {
  handle_directly: "handle directly",
  delegate_agent: "delegate agent",
  delegate_team: "delegate team",
  propose_team: "propose team",
  propose_specialist: "propose specialist",
  clarify: "clarify",
};

export function DispositionChip({ args }: ToolCallMessagePartProps<{ disposition: Disposition; reason: string }>) {
  if (args.disposition === "handle_directly") return null;
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={args.reason}>
      <span className="size-1.5 rounded-full bg-foreground/60" />
      <span className="rounded-full border px-2 py-0.5 font-mono">{DISPOSITION_LABEL[args.disposition]}</span>
    </div>
  );
}

// ---- people on cards: "Name · Role" with a portrait (NAME-1/2, D1) ----

/** The portrait for an agent or pool persona: the registry's sprite when there is one, else the card's still. */
function Face({ id, name, avatar, className }: { id?: string; name: string; avatar?: string; className?: string }) {
  useRegistry();
  const reg = registry();
  const sprite = (id ? reg.agents.find((p) => p.agent.id === id)?.agent.avatar ?? reg.personaPool.find((p) => p.id === id)?.avatar : undefined)
    ?? (avatar ? { still: avatar } : undefined);
  return sprite
    ? <AgentAvatar avatar={sprite} name={name} className={cn("size-6 shadow-none", className)} />
    : <InitialAvatar initial={name[0] ?? "?"} name={name} tone="bg-muted text-muted-foreground" className={cn("size-6 text-[7px] shadow-none", className)} />;
}

/** Who an id on a card is: its roster entry, else the registry, else the persona pool. */
function personOf(id: string, roster: TeamProposal["roster"] = []) {
  const r = roster.find((x) => x.agentId === id);
  if (r) return { id, name: r.name, role: r.role, avatar: r.avatar };
  const reg = registry();
  const agent = reg.agents.find((p) => p.agent.id === id)?.agent;
  if (agent) return { id, name: agent.name, role: agent.role, avatar: agent.avatar?.still };
  const pooled = reg.personaPool.find((p) => p.id === id);
  return { id, name: pooled?.name ?? id, role: pooled?.role, avatar: pooled?.avatar.still };
}

const NameRole = ({ name, role }: { name: string; role?: string }) => (
  <span className="min-w-0 truncate"><span className="font-medium">{name}</span>{role && <span className="text-muted-foreground"> · {role}</span>}</span>
);

const heading = "mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground";

function Rows({ rows }: { rows: ProposalRow[] }) {
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd><div>{r.value}</div><div className="text-muted-foreground">{r.why}</div></dd>
        </div>
      ))}
    </dl>
  );
}

// ---- decisions ----

type Decision = { decision: ProposalDecision };

/** The DOM id of a card, so a superseded card can point at its re-proposal (CARD-4). */
const cardDomId = (toolCallId: string) => `card-${toolCallId}`;

/** The toolCallId of the card that replaced this one, if Dana re-proposed it. */
function useSupersededBy(toolCallId: string): string | undefined {
  return useAuiState((s) => {
    for (const m of s.thread.messages) {
      for (const p of m.content) {
        if (p.type === "tool-call" && (p.args as { supersedes?: string } | undefined)?.supersedes === toolCallId) return p.toolCallId;
      }
    }
    return undefined;
  });
}

function Actions({ yes, addResult }: { yes: string; addResult: (r: Decision) => void }) {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  // Local runtime doesn't auto-resume after a human tool result, so start the next turn ourselves.
  // That run re-sends the thread with the {decision} on this card's part.
  const decide = (r: Decision) => {
    addResult(r);
    const msgs = aui.thread().getState().messages;
    aui.thread().startRun({ parentId: msgs[msgs.length - 1].id });
  };
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={running} onClick={() => decide({ decision: "approved" })}>{yes}</Button>
      <Button size="sm" variant="outline" disabled={running} onClick={() => decide({ decision: "declined" })}>No</Button>
      <Button size="sm" variant="ghost" disabled={running} onClick={() => decide({ decision: "discuss" })}>Chat about this</Button>
    </div>
  );
}

/** The card's status badge: pending, then whatever was decided (CARD-6: a declined card says so). */
function StatusBadge({ result, pending }: { result?: Decision; pending: string }) {
  if (result?.decision === "approved") return <Badge className="bg-ok-soft text-ok hover:bg-ok-soft"><Check className="size-3" /> Approved</Badge>;
  if (result?.decision === "declined") return <Badge variant="secondary" className="text-muted-foreground">Declined</Badge>;
  if (result?.decision === "discuss") return <Badge variant="secondary" className="text-muted-foreground">Discussing</Badge>;
  return <Badge className="bg-warn-soft text-warn hover:bg-warn-soft">{pending}</Badge>;
}

function DecisionNote({ result }: { result?: Decision }) {
  if (!result || result.decision === "approved") return null;
  return <div className="mt-3 text-xs text-muted-foreground">{result.decision === "discuss" ? "Discussing — nothing is created until you approve a proposal." : "Declined. Nothing was created."}</div>;
}

/** A card Dana replaced after "Chat about this" collapses to one line pointing at the new one (CARD-4). */
function Superseded({ icon: Icon, name, kind, by }: { icon: typeof Users; name: string; kind: string; by: string }) {
  return (
    <div className="my-3 flex items-center gap-2 rounded-xl border border-dashed px-4 py-2 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate"><span className="font-medium text-foreground/70">{name}</span> · {kind} · replaced by a revised proposal</span>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => document.getElementById(cardDomId(by))?.scrollIntoView({ behavior: "smooth", block: "center" })}>
        See revision <ArrowDown className="size-3" />
      </Button>
    </div>
  );
}

// ---- the team card (CARD-1) ----

function Workflow({ stages, roster }: { stages: NonNullable<TeamProposal["workflow"]>; roster: TeamProposal["roster"] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
      {stages.map((s, i) => {
        const people = s.agentIds.map((id) => personOf(id, roster));
        return (
          <li key={`${s.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/60" />}
            <span title={people.map((p) => p.name).join(", ")}
              className={cn("flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-xs", s.gate && "border-warn/40 bg-warn-soft/60")}>
              <span className="flex -space-x-1.5">
                {people.map((p) => <span key={p.id} className="inline-flex rounded-full ring-2 ring-card"><Face id={p.id} name={p.name} avatar={p.avatar} className="size-5" /></span>)}
              </span>
              {s.label}
              {s.gate && <CornerDownLeft className="size-3 text-warn" aria-label="Can send work back" />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TeamProposalCard({ args, result, addResult, toolCallId }: ToolCallMessagePartProps<TeamProposal, Decision>) {
  useRegistry();
  const supersededBy = useSupersededBy(toolCallId);
  if (supersededBy) return <Superseded icon={Users} name={args.name} kind="proposed team" by={supersededBy} />;
  const roster = args.roster ?? [];
  const lead = args.workflow?.[0]?.agentIds[0] ? personOf(args.workflow[0].agentIds[0], roster) : undefined;
  const reworkRow = args.leadDefaults?.find((r) => /rework/i.test(r.label));
  const leadDefaults = args.leadDefaults?.filter((r) => r !== reworkRow) ?? [];
  const rework = reworkRow ?? (args.reworkBudget !== undefined ? { value: `${args.reworkBudget} bounces, then it escalates to you`, why: "" } : undefined);
  const hasDetail = !!(args.criteria?.length || rework || leadDefaults.length);
  return (
    <div id={cardDomId(toolCallId)} className="my-3 scroll-mt-24 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><Users className="size-4 shrink-0" /><span className="truncate">{args.name}</span><span className="shrink-0 text-xs font-normal text-muted-foreground">proposed team</span></div>
        <StatusBadge result={result} pending="Needs approval" />
      </div>
      {args.purpose && <p className="mt-1 text-xs text-muted-foreground">{args.purpose}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {roster.map((r) => (
          <div key={r.agentId} className="flex min-w-0 items-center gap-1.5 rounded-lg border py-1 pl-1 pr-2.5 text-xs">
            <Face id={r.agentId} name={r.name} avatar={r.avatar} />
            <NameRole name={r.name} role={r.role} />
            <span className={r.status === "new" ? "text-run" : "text-muted-foreground"}>{r.status}</span>
          </div>
        ))}
      </div>
      {!!args.workflow?.length && (
        <div className="mt-3">
          <div className={heading}>Workflow</div>
          <Workflow stages={args.workflow} roster={roster} />
        </div>
      )}
      {hasDetail && (
        <div className="mt-3 grid gap-x-6 gap-y-3 @xl/main:grid-cols-2">
          <div className="space-y-3">
            {!!args.criteria?.length && (
              <div>
                <div className={heading}>Done when</div>
                <ul className="space-y-1 text-xs">
                  {args.criteria.map((c) => <li key={c} className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />{c}</li>)}
                </ul>
              </div>
            )}
            {rework && (
              <div>
                <div className={heading}>Rework budget</div>
                <div className="text-xs">{rework.value}</div>
                {rework.why && <div className="text-xs text-muted-foreground">{rework.why}</div>}
              </div>
            )}
          </div>
          {leadDefaults.length > 0 && (
            <div>
              <div className={heading}>{lead ? `${lead.name}'s defaults · new lead` : "New lead's defaults"}</div>
              <Rows rows={leadDefaults} />
            </div>
          )}
        </div>
      )}
      {!result && <div className="mt-4"><Actions yes="Build team" addResult={addResult} /></div>}
      <DecisionNote result={result} />
    </div>
  );
}

// ---- the specialist card (D1, CARD-3) ----

export function SpecialistProposalCard({ args, result, addResult, toolCallId }: ToolCallMessagePartProps<SpecialistProposal, Decision>) {
  useRegistry();
  const supersededBy = useSupersededBy(toolCallId);
  if (supersededBy) return <Superseded icon={UserPlus} name={args.persona?.name ?? args.name} kind="new specialist" by={supersededBy} />;
  const persona = args.persona;
  // CARD-3: once approved, the agent's inbox from the registry — only when one really exists.
  const inbox = result?.decision === "approved" && persona ? registry().agents.find((p) => p.agent.id === persona.id)?.inbox : undefined;
  return (
    <div id={cardDomId(toolCallId)} className="my-3 scroll-mt-24 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {persona ? <Face id={persona.id} name={persona.name} avatar={persona.avatar} className="size-7" /> : <UserPlus className="size-4 shrink-0" />}
          {persona ? <NameRole name={persona.name} role={persona.role} /> : <span className="font-medium">{args.name}</span>}
        </div>
        <StatusBadge result={result} pending="New specialist" />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{args.purpose}</p>
      <div className="mt-3"><Rows rows={args.rows ?? []} /></div>
      {inbox && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="size-3.5" />Inbox <span className="font-mono text-foreground">{inbox}</span> · created</div>
      )}
      {!result && <div className="mt-4"><Actions yes={`Yes, create ${persona?.name ?? args.name}`} addResult={addResult} /></div>}
      <DecisionNote result={result} />
    </div>
  );
}

// ---- the handoff card ----

const isHandoff = (v: unknown): v is HandoffPayload => !!v && typeof v === "object" && typeof (v as HandoffPayload).runId === "string";

/**
 * The handoff. A live turn streams the call as soon as Dana makes it, with only her own args; the
 * payload (run, task, members) lands with the result a few seconds later — until then the card says
 * it's handing off, and there's no loop to link to yet.
 */
export function HandoffCard({ args, result }: ToolCallMessagePartProps<HandoffPayload | { teamName?: string }, HandoffPayload>) {
  useRegistry();
  const payload = isHandoff(result) ? result : isHandoff(args) ? args : undefined;
  if (!payload) {
    return (
      <div className="my-3 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><Rocket className="size-4 shrink-0" /><span className="truncate">Handing off to {args.teamName ?? "the team"}…</span></div>
          <Badge variant="secondary" className="gap-1 text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Starting</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Compiling the brief and starting the run.</p>
      </div>
    );
  }
  const loop = payload.taskId ? `/work/${payload.taskId}?live=1` : `/runs/${payload.runId}?live=1`;
  return (
    <div className="my-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><Rocket className="size-4 shrink-0" /><span className="truncate">Task handed off to {payload.teamName}</span></div>
        <Badge className="bg-run-soft text-run hover:bg-run-soft">Running</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{payload.summary}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 @xl/main:grid-cols-4">
        {(payload.members ?? []).map((m) => (
          <div key={m.agentId ?? m.name} className="flex min-w-0 items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs">
            <Face id={m.agentId} name={m.name} className="size-7" />
            <div className="min-w-0">
              <div className="truncate font-medium">{m.name}</div>
              {m.role && <div className="truncate text-[11px] text-muted-foreground">{m.role}</div>}
              <div className="flex items-center gap-1 text-muted-foreground"><span className="size-1.5 shrink-0 rounded-full bg-run" />{m.state}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" asChild><Link to={loop}>View loop <ArrowRight /></Link></Button>
      </div>
    </div>
  );
}

// ---- the results message (CHAT-14) ----

/** Dana's results, posted to the thread when the loop finishes: the valid rows, the report and the loop. */
export function ResultsCard({ args }: ToolCallMessagePartProps<ResultsPayload>) {
  const rows = (args.rows ?? []).filter((r) => r.valid);
  return (
    <div className="my-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2 text-sm font-medium"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />{args.title}</div>
        <Badge className="shrink-0 bg-ok-soft text-ok hover:bg-ok-soft">Results</Badge>
      </div>
      {args.summary && <p className="mt-1 text-xs text-muted-foreground">{args.summary}</p>}
      {rows.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <tbody className="divide-y divide-foreground/10">
            {rows.map((r) => (
              <tr key={r.config}><td className="py-1.5">{r.config}</td><td className="py-1.5 text-right font-mono tabular-nums">{r.ppl}</td><td className="w-16 py-1.5 text-right tabular-nums text-muted-foreground">{r.delta}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" asChild><Link to={`/reports/${args.reportId}`}>Open report <ArrowRight /></Link></Button>
        <Button size="sm" variant="outline" asChild><Link to={`/work/${args.taskId}`}>View loop</Link></Button>
      </div>
    </div>
  );
}
