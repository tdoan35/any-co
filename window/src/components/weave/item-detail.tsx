import { Link } from "react-router";
import { useEffect, useState } from "react";
import { AlarmClock, ArrowRight, Check, Hourglass, Info, Lock, Quote, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { policyStyle } from "@/components/chat/assistant-hero";
import { api } from "@/lib/api";
import type { ApprovalItem, EscalationItem, FindingItem, InboxItem, ItemAction, ProposalItem, QuestionItem, ResultItem } from "@/lib/mock/weave";
import type { Report } from "@fabric/contracts";
import { weave, type ItemState, type WeaveState } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { ago, fmtTime, waited } from "./format";
import { Face, KIND, NameRole, ProjectChip, RunChip, agentOf } from "./parts";
import { SnoozeMenu } from "./inbox";

const box = "rounded-xl border border-foreground/10 bg-background/60";

function ApprovalBody({ item }: { item: ApprovalItem }) {
  return (
    <>
      <div className={box}>
        <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2">
          <code className="font-mono text-xs font-medium">{item.tool}</code>
          <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", policyStyle[item.policy])}>{item.policy}</span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{item.policyNote}</span>
        </div>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs">
          {item.preview.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="break-words">{r.value}</dd>
            </div>
          ))}
        </dl>
        {item.excerpt && <p className="border-t border-foreground/10 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{item.excerpt}</p>}
      </div>
      {item.gated && (
        <p className="flex gap-2 rounded-lg bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />{item.gated}
        </p>
      )}
    </>
  );
}

function QuestionBody({ item }: { item: QuestionItem }) {
  return (
    <>
      <p className="text-sm leading-relaxed">{item.question}</p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        {item.context.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </>
  );
}

function EscalationBody({ item }: { item: EscalationItem }) {
  return (
    <>
      <p className="text-sm leading-relaxed">{item.body}</p>
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">Rework budget</span>
        <span className="flex gap-1" role="img" aria-label={`${item.budget.used} of ${item.budget.total} used`}>
          {Array.from({ length: item.budget.total }, (_, i) => (
            <span key={i} className={cn("h-1.5 w-8 rounded-full", i < item.budget.used ? "bg-warn" : "bg-foreground/10")} />
          ))}
        </span>
        <span className="tabular-nums text-warn">{item.budget.used} / {item.budget.total} spent</span>
      </div>
      <ol className={cn(box, "space-y-2 px-3 py-2.5")}>
        {item.history.map((h) => (
          <li key={h.at} className="flex items-start gap-2 text-xs">
            <Face id={h.agentId} size="size-5" />
            <span className="min-w-0 flex-1"><span className="font-medium">{agentOf(h.agentId).name}</span> <span className="text-muted-foreground">{h.text}</span></span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(h.at)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function ProposalBody({ item }: { item: ProposalItem }) {
  const lead = item.roster.find((r) => r.status === "lead");
  return (
    <>
      <p className="text-sm leading-relaxed">{item.purpose}</p>
      <div className="flex flex-wrap gap-2">
        {item.roster.map((r) => (
          <span key={r.agentId} className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-background/60 py-1 pl-1 pr-2.5 text-xs">
            <Face id={r.agentId} size="size-6" />
            <span className="font-medium">{agentOf(r.agentId).name}</span>
            <span className={r.status === "lead" ? "text-warn" : "text-muted-foreground"}>{r.status}</span>
          </span>
        ))}
      </div>
      <dl className={cn(box, "grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs")}>
        <dt className="text-muted-foreground">Goes to {lead ? agentOf(lead.agentId).name : "the team"}</dt><dd>{item.crosses}</dd>
        <dt className="text-muted-foreground">Stays with me</dt><dd>{item.stays}</dd>
      </dl>
    </>
  );
}

function FindingBody({ item }: { item: FindingItem }) {
  return (
    <>
      <div className={cn(box, "px-3 py-2.5")}>
        <div className="text-sm font-medium">{item.source.title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{item.source.venue} · <span className="font-mono">{item.source.url}</span></div>
      </div>
      <p className="text-sm leading-relaxed">{item.relevance}</p>
      {item.challenges && (
        <p className="flex gap-2 rounded-lg bg-warn-soft/60 px-3 py-2 text-xs">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span>Challenges {item.challenges.owner}: <span className="italic">“{item.challenges.text}”</span></span>
        </p>
      )}
    </>
  );
}

function ResultBody({ item }: { item: ResultItem }) {
  const [report, setReport] = useState<Report>();
  useEffect(() => { let active = true; void api.getReport(item.reportId).then((value) => { if (active) setReport(value); }); return () => { active = false; }; }, [item.reportId]);
  if (!report) return <p className="text-sm text-muted-foreground">Loading report…</p>;
  return (
    <>
      <p className="text-sm leading-relaxed">{report.summary}</p>
      <table className={cn(box, "w-full border-separate border-spacing-0 overflow-hidden text-xs")}>
        <tbody>
          {report.results.filter((r) => r.valid).map((r) => (
            <tr key={r.config}>
              <td className="px-3 py-1.5">{r.config}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.ppl}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Body({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case "approval": return <ApprovalBody item={item} />;
    case "question": return <QuestionBody item={item} />;
    case "escalation": return <EscalationBody item={item} />;
    case "proposal": return <ProposalBody item={item} />;
    case "finding": return <FindingBody item={item} />;
    case "result": return <ResultBody item={item} />;
  }
}

function ActionButton({ item, action }: { item: InboxItem; action: ItemAction }) {
  const variant = action.variant === "primary" ? "default" : action.variant === "ghost" ? "ghost" : "outline";
  if (action.href) {
    return <Button size="sm" variant={variant} asChild><Link to={action.href}>{action.label}{action.variant === "primary" && <ArrowRight />}</Link></Button>;
  }
  return <Button size="sm" variant={variant} onClick={() => weave.resolve(item.id, action.id)}>{action.label}</Button>;
}

function Actions({ item }: { item: InboxItem }) {
  // Options that carry a consequence (time, cost) render as cards so the tradeoff is visible before you pick.
  const options = item.actions.filter((a) => a.detail);
  const buttons = item.actions.filter((a) => !a.detail);
  return (
    <div className="space-y-3">
      {options.length > 0 && (
        <div className={cn("grid gap-2", options.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          {options.map((a) => (
            <button key={a.id} type="button" onClick={() => weave.resolve(item.id, a.id)}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                a.variant === "primary" ? "border-foreground/25 bg-background hover:bg-background/70" : "border-foreground/10 bg-background/50 hover:bg-background/80",
              )}>
              <div className="text-sm font-medium">{a.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{a.detail}</div>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {buttons.map((a) => <ActionButton key={a.id} item={item} action={a} />)}
        <SnoozeMenu item={item}>
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground"><AlarmClock />Snooze</Button>
        </SnoozeMenu>
      </div>
    </div>
  );
}

function Resolved({ item, st, canUndo }: { item: InboxItem; st: ItemState; canUndo: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/5 px-3 py-2 text-xs">
      {st.status === "done"
        ? <span className="flex items-center gap-1.5 font-medium text-ok"><Check className="size-3.5" />{st.outcome}{st.doneAt && <span className="font-normal text-muted-foreground"> · {fmtTime(st.doneAt)}</span>}</span>
        : <span className="flex items-center gap-1.5 text-muted-foreground"><AlarmClock className="size-3.5" />Snoozed · {st.snoozedUntil}</span>}
      <span className="ml-auto flex gap-1">
        {st.status === "snoozed" && <Button size="xs" variant="ghost" onClick={() => weave.unsnooze(item.id)}>Unsnooze</Button>}
        {canUndo && <Button size="xs" variant="ghost" onClick={() => weave.undo()}><Undo2 />Undo</Button>}
      </span>
    </div>
  );
}

export function ItemDetail({ item, st, last }: { item: InboxItem; st: ItemState; last: WeaveState["last"] }) {
  const kind = KIND[item.kind];
  return (
    <div className="mx-auto max-w-[640px]">
      <article className="space-y-4 rounded-2xl border border-foreground/10 bg-background/70 p-5 shadow-sm backdrop-blur-md">
        <header className="flex items-start gap-3">
          <Face id={item.agentId} size="size-10" kind={item.kind} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              <NameRole id={item.agentId} />
              <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-xs font-medium", kind.tone)}><kind.icon className="size-3.5" />{kind.label}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{fmtTime(item.at)} · {ago(item.at)}</div>
          </div>
        </header>
        <div className="flex flex-wrap gap-1.5">
          <ProjectChip name={item.project} />
          {item.run && <RunChip run={item.run} />}
        </div>
        <h2 className="text-lg font-semibold leading-snug tracking-tight">{item.title}</h2>
        {st.status === "open" && item.blocking && (
          <p className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            <Hourglass className="size-3.5 shrink-0" />
            Blocks {item.blocking.step}. {agentOf(item.blocking.agentId).name} has been waiting {waited(item.blocking.since)}.
          </p>
        )}
        <Body item={item} />
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span><span className="font-medium text-foreground/80">Why you're seeing this.</span> {item.why}</span>
        </p>
        <div className="border-t border-foreground/10 pt-4">
          {st.status === "open"
            ? <Actions item={item} />
            : <Resolved item={item} st={st} canUndo={last?.itemId === item.id} />}
        </div>
      </article>
    </div>
  );
}
