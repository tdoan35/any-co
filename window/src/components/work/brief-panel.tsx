import type { ReactNode } from "react";
import { Check, Circle, FileText, Lock, MousePointerClick, X } from "lucide-react";
import { Face, agentOf } from "@/components/weave/parts";
import { fmtClock, fmtSpan, type CriterionView } from "@/lib/run-state";
import type { Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Label } from "./parts";

const CRIT: Record<CriterionView["state"], { icon: typeof Check; cls: string; word: string }> = {
  pass: { icon: Check, cls: "bg-ok-soft text-ok", word: "Met" },
  fail: { icon: X, cls: "bg-warn-soft text-warn", word: "Not met" },
  pending: { icon: Circle, cls: "bg-foreground/5 text-muted-foreground", word: "Not checked yet" },
};

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <Label right={right}>{title}</Label>
      {children}
    </section>
  );
}

/**
 * What crossed the delegation boundary into this loop, and what stayed with Dana (PRODUCT §2.6),
 * with the loop's completion criteria checked off as evidence arrives.
 */
export function BriefPanel({ run, criteria, teamName }: { run: Run; criteria: CriterionView[]; teamName: string }) {
  const { brief } = run;
  const met = criteria.filter((c) => c.state === "pass").length;
  return (
    <div className="space-y-5 p-4">
      <header className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/5"><FileText className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Brief</h2>
          <p className="text-xs text-muted-foreground">Compiled by the Studio Head for {teamName} · {brief.tokens.toLocaleString()} tokens</p>
        </div>
      </header>

      <p className="text-sm leading-relaxed">{brief.objective}</p>

      <Section title="Done when" right={<span className="tabular-nums">{met} of {criteria.length} met</span>}>
        <ul className="space-y-1.5">
          {brief.criteria.map((text, i) => {
            const c = criteria[i];
            const s = CRIT[c.state];
            return (
              <li key={text} className="flex gap-2.5 rounded-lg px-1 py-1">
                <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded-full", s.cls)} title={s.word}><s.icon className="size-3" /></span>
                <span className="min-w-0 text-xs leading-snug">
                  <span className={cn(c.state === "pending" && "text-muted-foreground")}>{text}</span>
                  {c.note && (
                    <span className={cn("mt-0.5 flex items-center gap-1 text-[11px]", c.state === "fail" ? "text-warn" : "text-muted-foreground")}>
                      {c.by && <Face id={c.by} size="size-3.5" />}
                      <span className="min-w-0">{c.by && `${agentOf(c.by).name}: `}{c.note} · {fmtClock(c.t ?? 0)}</span>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Constraints">
        <ul className="space-y-1 text-xs leading-snug">
          {brief.constraints.map((c) => <li key={c} className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />{c}</li>)}
        </ul>
      </Section>

      <Section title="Budget">
        <p className="text-xs">Rework {run.reworkBudget} · {fmtSpan(run.budget.timeS)}</p>
      </Section>

      <Section title="Your preferences" right="from each USER.md">
        <div className="flex flex-wrap gap-1.5">
          {brief.preferences.map((p) => <span key={p} className="rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px]">{p}</span>)}
        </div>
      </Section>

      <section className="rounded-lg bg-foreground/5 px-3 py-2.5">
        <Label className="text-foreground/80"><Lock className="size-3.5" />Stayed with the Studio Head</Label>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{brief.stayed.join(" · ")}</p>
      </section>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MousePointerClick className="size-3.5 shrink-0" />Pick someone's row to see exactly what they loaded.
      </p>
    </div>
  );
}
