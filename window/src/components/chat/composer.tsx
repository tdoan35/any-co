import { useState } from "react";
import { AttachmentPrimitive, ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { ContextMeter } from "./composer-bar";
import { ArrowUp, AudioLines, Check, ChevronDown, FlaskConical, Hand, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { APPROVALS, MODELS } from "@/lib/mock/options";
import { demoMode, liveChat } from "@/lib/chat/demo";
import { disarmFixture, useFixtureArmed } from "@/lib/chat/fixture";
import { EFFORT_LABELS, setChatEffort, setChatModel, useModelChoice, type Effort } from "@/lib/chat/model-choice";

// D7: the demo build never offers Full auto.
const approvals = demoMode ? APPROVALS.filter((a) => a.id !== "auto") : APPROVALS;


function ApprovalPicker() {
  const [value, setValue] = useState(approvals[0].id);
  const current = approvals.find((a) => a.id === value)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
          <Hand className="size-3.5" />
          <span className="sr-only">Approval mode</span>
          <span className="hidden @lg/composer:inline">{current.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Approvals</DropdownMenuLabel>
        {approvals.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => setValue(a.id)} className="justify-between gap-3">
            <span><span className="block text-sm">{a.name}</span><span className="block text-xs text-muted-foreground">{a.note}</span></span>
            {a.id === value && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Sent with every chat turn (lib/chat/model-choice): Dana runs on the pick, or on her own model.
function ModelPicker() {
  const { model, effort } = useModelChoice();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs hover:text-foreground">
          <span className="sr-only">Model and reasoning effort</span>
          <span>{model ?? "Agent default"}</span><span className="hidden text-muted-foreground @md/composer:inline">{EFFORT_LABELS[effort]}</span><ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setChatModel(null); }} className="justify-between">
          <span>Agent default<span className="ml-2 text-xs text-muted-foreground">Set in Studio</span></span>
          {model === null && <Check className="size-3.5" />}
        </DropdownMenuItem>
        {MODELS.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={(e) => { e.preventDefault(); setChatModel(m.name); }} className="justify-between">
            <span>{m.name}<span className="ml-2 text-xs text-muted-foreground">{m.note}</span></span>
            {m.name === model && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Reasoning effort</DropdownMenuLabel>
        {(Object.keys(EFFORT_LABELS) as Effort[]).map((e) => (
          <DropdownMenuItem key={e} onSelect={(ev) => { ev.preventDefault(); setChatEffort(e); }} className="justify-between">
            {EFFORT_LABELS[e]}{e === effort && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachmentChip() {
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-lg border bg-muted px-2 py-1 text-xs">
      <Paperclip className="size-3 text-muted-foreground" />
      <span className="max-w-40 truncate"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <button type="button" aria-label="Remove attachment" className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/** Shown while the fixture hotkey (Ctrl+Shift+F) has scripted Dana armed for the next turn; click to disarm. */
function FixtureArmed() {
  const armed = useFixtureArmed();
  if (!armed) return null;
  return (
    <button type="button" onClick={disarmFixture} title="Scripted Dana answers the next turn (Ctrl+Shift+F). Click to cancel."
      className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground hover:text-foreground">
      <FlaskConical className="size-3" />Scripted next turn
    </button>
  );
}

/** `showContext` moves the context meter into the toolbar (used once the tray has hidden). */
export function Composer({ autoFocus, placeholder, showContext }: { autoFocus?: boolean; placeholder: string; showContext?: boolean }) {
  const empty = useAuiState((st) => st.composer.isEmpty);
  return (
    <ComposerPrimitive.Root className="relative z-10 rounded-2xl border bg-card shadow-sm">
      <div className="empty:hidden flex flex-wrap gap-2 px-3 pt-3">
        <ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      <ComposerPrimitive.Input
        rows={2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        className="block max-h-56 min-h-20 w-full resize-none bg-transparent px-4 pt-4 pb-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        {!liveChat && (
          <ComposerPrimitive.AddAttachment asChild>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-foreground" aria-label="Attach files"><Plus /></Button>
          </ComposerPrimitive.AddAttachment>
        )}
        {!liveChat && <ApprovalPicker />}
        <FixtureArmed />
        <div className="mx-2 flex min-w-0 flex-1 items-center">
          <AnimatePresence>
            {showContext && !demoMode && !liveChat && (
              <motion.div
                className="flex min-w-0 flex-1"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: 0.3, duration: 0.35 } }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
              >
                <ContextMeter />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-0.5">
          {!liveChat && <ModelPicker />}
          <ComposerPrimitive.If dictation={false}>
            {!liveChat && <ComposerPrimitive.Dictate asChild>
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-foreground" aria-label="Dictate"><Mic /></Button>
            </ComposerPrimitive.Dictate>}
          </ComposerPrimitive.If>
          <ComposerPrimitive.If dictation>
            <ComposerPrimitive.StopDictation asChild>
              <Button variant="ghost" size="icon" className="size-8 animate-pulse text-destructive" aria-label="Stop dictation"><Square className="fill-current" /></Button>
            </ComposerPrimitive.StopDictation>
          </ComposerPrimitive.If>
          {empty && !demoMode && !liveChat ? (
            <Button type="button" size="icon" className="ml-1 size-8 rounded-full bg-run text-white hover:bg-run/90" aria-label="Voice conversation"><AudioLines /></Button>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button size="icon" className="ml-1 size-8 rounded-full" aria-label="Send"><ArrowUp /></Button>
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
