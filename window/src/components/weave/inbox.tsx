import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlarmClock, Check, ChevronRight, Clock, Undo2, X, Zap } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { InboxItem } from "@/lib/mock/weave";
import { inboxGroups, isAsk, weave, type ItemState, type WeaveState } from "@/lib/weave-store";
import { cn } from "@/lib/utils";
import { age, fmtTime, waited } from "./format";
import { ColumnHeader, ColumnLabel, Face, NameRole, agentOf } from "./parts";
import { quietScroll, useEdgeFade } from "./use-edge-fade";

const TIME_SNOOZE = [
  { label: "Later today", hint: "3:00 PM", until: "Until 3:00 PM today" },
  { label: "Tomorrow", hint: "Sat 9:00 AM", until: "Until tomorrow 9:00 AM" },
  { label: "Next week", hint: "Mon 9:00 AM", until: "Until Monday 9:00 AM" },
];

/** Linear's snooze menu, plus "when something happens" for items that depend on an agent's work. */
export function SnoozeMenu({ item, open, onOpenChange, children }: { item: InboxItem; open?: boolean; onOpenChange?: (o: boolean) => void; children: ReactNode }) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Snooze</DropdownMenuLabel>
        {TIME_SNOOZE.map((o) => (
          <DropdownMenuItem key={o.label} onSelect={() => weave.snooze(item.id, o.until)}>
            <Clock />{o.label}<DropdownMenuShortcut>{o.hint}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        {item.snoozeEvents && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">When something happens</DropdownMenuLabel>
            {item.snoozeEvents.map((e) => (
              <DropdownMenuItem key={e} onSelect={() => weave.snooze(item.id, e)}><Zap />{e}</DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowAction({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Row({ item, st, selected, focused, onOpen, snoozeOpen, onSnoozeOpenChange }: {
  item: InboxItem; st: ItemState; selected: boolean; focused: boolean; onOpen: () => void;
  snoozeOpen: boolean; onSnoozeOpenChange: (o: boolean) => void;
}) {
  const ask = isAsk(item);
  // One-click ✓ / ✗ only for approvals that aren't human-authority gates. Gated ones (external send, spend…),
  // questions and escalations open first, so you see the payload or each option's cost before deciding.
  const approval = item.kind === "approval" && !item.gated;
  const yes = approval ? item.actions.find((a) => a.variant === "primary" && a.effect) : undefined;
  const no = approval ? item.actions.find((a) => a.variant === "ghost" && a.effect) : undefined;
  const live = st.status !== "done";
  return (
    <div className="group/row relative" data-item={item.id}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        className={cn(
          "flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-background/80 shadow-sm ring-1 ring-foreground/10 hover:bg-background/80",
          focused && !selected && "ring-1 ring-inset ring-foreground/20",
          // Keyboard focus (not a mouse click) reveals the actions, so a clicked row doesn't stay squeezed.
          live && "group-hover/row:pr-20 group-has-[:focus-visible]/row:pr-20",
          snoozeOpen && "pr-20",
        )}
      >
        <Face id={item.agentId} kind={item.kind} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs">
            <NameRole id={item.agentId} />
            <span className={cn("ml-auto shrink-0 tabular-nums text-muted-foreground", live && "group-hover/row:invisible group-has-[:focus-visible]/row:invisible", snoozeOpen && "invisible")}>{age(item.at)}</span>
          </span>
          <span className={cn("mt-0.5 line-clamp-2 text-[13px] leading-snug", st.status === "done" ? "text-muted-foreground" : "text-foreground", st.unread && "font-medium")}>
            {item.title}
          </span>
          {st.status === "open" && item.blocking && (
            <span className="mt-1 block truncate text-[11px] text-warn">
              Blocks {item.blocking.step} · {agentOf(item.blocking.agentId).name}, {waited(item.blocking.since)}
            </span>
          )}
          {st.status === "snoozed" && (
            <span className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground"><AlarmClock className="size-3 shrink-0" />{st.snoozedUntil}</span>
          )}
          {st.status === "done" && (
            <span className="mt-1 flex items-center gap-1 truncate text-[11px] text-ok"><Check className="size-3 shrink-0" />{st.outcome}{st.doneAt && ` · ${fmtTime(st.doneAt)}`}</span>
          )}
        </span>
      </button>
      {st.unread && <span role="img" aria-label="Unread" className="pointer-events-none absolute left-0.5 top-4 size-1.5 rounded-full bg-run" />}
      {live && (
        <div className={cn(
          "absolute right-2 top-1.5 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100",
          snoozeOpen && "opacity-100",
        )}>
          {yes && <RowAction label={yes.label} onClick={() => weave.resolve(item.id, yes.id)}><Check className="size-3.5" /></RowAction>}
          {no && <RowAction label={no.label} onClick={() => weave.resolve(item.id, no.id)}><X className="size-3.5" /></RowAction>}
          {!ask && st.status === "open" && <RowAction label="Done" onClick={() => weave.markDone(item.id)}><Check className="size-3.5" /></RowAction>}
          {st.status === "snoozed"
            ? <RowAction label="Unsnooze" onClick={() => weave.unsnooze(item.id)}><AlarmClock className="size-3.5" /></RowAction>
            : (
              <SnoozeMenu item={item} open={snoozeOpen} onOpenChange={onSnoozeOpenChange}>
                <button type="button" aria-label="Snooze" className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10">
                  <AlarmClock className="size-3.5" />
                </button>
              </SnoozeMenu>
            )}
        </div>
      )}
    </div>
  );
}

/** Shows the last change for a few seconds with an Undo. */
function UndoToast({ last }: { last: WeaveState["last"] }) {
  const [hiddenAt, setHiddenAt] = useState<number>();
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setHiddenAt(last.at), 6000);
    return () => clearTimeout(t);
  }, [last]);
  const show = !!last && hiddenAt !== last.at;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key={last.at}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2 }}
          role="status"
          className="pointer-events-auto mx-2 flex items-center gap-2 rounded-lg border border-foreground/10 bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur"
        >
          <Check className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0 flex-1 truncate">{last.label}</span>
          <button type="button" onClick={() => weave.undo()} className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground">
            <Undo2 className="size-3" />Undo
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const list = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: "auto" }, exit: { opacity: 0, height: 0 }, transition: { duration: 0.2 } };

function Rows({ items, state, ctx }: { items: InboxItem[]; state: WeaveState; ctx: RowContext }) {
  return (
    <ul className="space-y-0.5">
      <AnimatePresence initial={false}>
        {items.map((i) => (
          <motion.li key={i.id} {...list} className="overflow-hidden px-0.5 py-px">
            <Row
              item={i} st={state.status[i.id]}
              selected={ctx.selectedId === i.id} focused={ctx.focusId === i.id}
              onOpen={() => ctx.onOpen(i.id)}
              snoozeOpen={ctx.snoozeFor === i.id}
              onSnoozeOpenChange={(o) => ctx.setSnoozeFor(o ? i.id : null)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

interface RowContext {
  selectedId: string | null;
  focusId: string | null;
  onOpen: (id: string) => void;
  snoozeFor: string | null;
  setSnoozeFor: (id: string | null) => void;
}

export function Inbox({ state, showDone, onToggleDone, ...ctx }: RowContext & { state: WeaveState; showDone: boolean; onToggleDone: () => void }) {
  const g = inboxGroups(state);
  const [listRef, listFade] = useEdgeFade<HTMLDivElement>();
  return (
    <div className="relative flex min-h-0 flex-col">
      <ColumnHeader>
        <h2 className="text-sm font-semibold">Inbox</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{g.needs.length + g.forYou.length} open</span>
        <button type="button" onClick={onToggleDone} aria-pressed={showDone}
          className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-pressed:bg-foreground/5 aria-pressed:text-foreground">
          Done · {g.done.length}
        </button>
      </ColumnHeader>
      <div ref={listRef} style={listFade} className={cn("min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-16 pt-3", quietScroll)}>
        <section>
          <ColumnLabel count={g.needs.length}>Needs you</ColumnLabel>
          <div className="mt-1.5">
            {g.needs.length
              ? <Rows items={g.needs} state={state} ctx={ctx} />
              : <p className="mx-1 rounded-lg border border-dashed border-foreground/15 px-3 py-4 text-center text-xs text-muted-foreground">Nothing is waiting on you. Your agents will ask here when something does.</p>}
          </div>
        </section>
        {g.forYou.length > 0 && (
          <section>
            <ColumnLabel count={g.forYou.length}>For you</ColumnLabel>
            <div className="mt-1.5"><Rows items={g.forYou} state={state} ctx={ctx} /></div>
          </section>
        )}
        {g.snoozed.length > 0 && (
          <Collapsible asChild>
            <section>
              <CollapsibleTrigger className="group/snz flex w-full items-center rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight className="mr-1 size-3.5 transition-transform group-data-[state=open]/snz:rotate-90" />Snoozed<span className="ml-1.5 tabular-nums">· {g.snoozed.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5 data-[state=closed]:animate-[collapsible-up_0.2s_ease-out] data-[state=open]:animate-[collapsible-down_0.2s_ease-out]">
                <Rows items={g.snoozed} state={state} ctx={ctx} />
              </CollapsibleContent>
            </section>
          </Collapsible>
        )}
        {showDone && (
          <section>
            <ColumnLabel count={g.done.length}>Done</ColumnLabel>
            <div className="mt-1.5">
              {g.done.length
                ? <Rows items={g.done} state={state} ctx={ctx} />
                : <p className="px-2 py-2 text-xs text-muted-foreground">Nothing done yet today.</p>}
            </div>
          </section>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 pb-2">
        <UndoToast last={state.last} />
      </div>
    </div>
  );
}
