import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import { Check, FileText, Folder, LifeBuoy, MessageCircleQuestion, Play, ShieldCheck, Sparkles, Telescope } from "lucide-react";
import { Portrait } from "@/components/chat/assistant-hero";
import { profileById } from "@/lib/registry";
import type { Health, ItemKind } from "@/lib/mock/weave";
import { cn } from "@/lib/utils";

/** Each inbox kind gets a glyph and a tone from the semantic palette (run / ok / warn / replay). */
export const KIND: Record<ItemKind, { label: string; icon: ComponentType<{ className?: string }>; tone: string }> = {
  approval: { label: "Approval", icon: ShieldCheck, tone: "text-warn" },
  question: { label: "Question", icon: MessageCircleQuestion, tone: "text-run" },
  escalation: { label: "Escalation", icon: LifeBuoy, tone: "text-warn" },
  proposal: { label: "Proposal", icon: Sparkles, tone: "text-replay" },
  finding: { label: "Finding", icon: Telescope, tone: "text-run" },
  result: { label: "Result", icon: FileText, tone: "text-ok" },
};

export const agentOf = (id: string) => profileById(id).agent;

/** A persona portrait, or Ty's initial for "you". The kind glyph sits on the bottom-right edge. */
export function Face({ id, size = "size-8", kind, className }: { id: string; size?: string; kind?: ItemKind; className?: string }) {
  const glyph = kind && KIND[kind];
  return (
    <span className={cn("relative inline-flex h-fit shrink-0 self-start", className)}>
      {id === "you"
        ? <span className={cn(size, "flex items-center justify-center rounded-full bg-foreground/10 text-[10px] font-semibold")} role="img" aria-label="You">T</span>
        : <Portrait agent={agentOf(id)} className={cn(size, "border border-foreground/15 text-xs shadow-none")} />}
      {glyph && (
        <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-foreground/10" title={glyph.label}>
          <glyph.icon className={cn("size-2.5", glyph.tone)} />
        </span>
      )}
    </span>
  );
}

/** "Jonah · Coder": the display rule everywhere (PRODUCT §3). */
export function NameRole({ id, className }: { id: string; className?: string }) {
  if (id === "you") return <span className={cn("font-medium", className)}>You</span>;
  const a = agentOf(id);
  return (
    <span className={cn("min-w-0 truncate", className)}>
      <span className="font-medium text-foreground">{a.name}</span>
      <span className="text-muted-foreground"> · {a.role}</span>
    </span>
  );
}

const chip = "inline-flex max-w-full items-center gap-1 rounded-md border border-foreground/10 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground";

export function ProjectChip({ name }: { name: string }) {
  return <span className={chip}><Folder className="size-3 shrink-0" /><span className="truncate">{name}</span></span>;
}

export function RunChip({ run }: { run: { label: string; href: string } }) {
  return (
    <Link to={run.href} className={cn(chip, "transition-colors hover:border-foreground/25 hover:text-foreground")}>
      <Play className="size-3 shrink-0" /><span className="truncate">{run.label}</span>
    </Link>
  );
}

export function ArtifactChip({ name }: { name: string }) {
  return <span className={cn(chip, "font-mono")}><FileText className="size-3 shrink-0" />{name}</span>;
}

const HEALTH: Record<Health, { label: string; className: string }> = {
  on_track: { label: "On track", className: "bg-ok-soft text-ok" },
  at_risk: { label: "At risk", className: "bg-warn-soft text-warn" },
  done: { label: "Done", className: "bg-ok-soft text-ok" },
};

export function HealthPill({ health }: { health: Health }) {
  const h = HEALTH[health];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium", h.className)}>
      {health === "done" ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
      {h.label}
    </span>
  );
}

/** The title row every Weave column shares, so the three line up across the panel. */
export function ColumnHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-foreground/10 px-4", className)}>{children}</div>;
}

/** Small heading for a column section. */
export function ColumnLabel({ children, count, right }: { children: ReactNode; count?: number; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
      {children}
      {count !== undefined && <span className="tabular-nums">· {count}</span>}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
