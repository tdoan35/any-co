// The body of an approval item. Known gates (art sign-off, release, outreach) get their input laid
// out as fields with the exact terminal commands to decide them; anything else keeps the preview rows.
// The window cannot approve: deciding stays in the terminal (`npm run approvals`).
import { useState } from "react";
import { Check, Copy, Hourglass, ImageIcon, Lock, Terminal } from "lucide-react";
import { policyStyle } from "@/components/chat/assistant-hero";
import type { ApprovalItem } from "@/lib/mock/weave";
import { APPROVAL_TIMEOUT_MIN, approvalCommands, gateOf, parseApprovalInput, type Field } from "@/lib/approval-gate";
import { cn } from "@/lib/utils";
import { waited } from "./format";

const box = "rounded-xl border border-foreground/10 bg-background/60";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked: the command stays selectable */ });
  };
  return (
    <button type="button" onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** The image slot: shaped for the contact sheet. Shows the path until the adapter serves files. */
function ImageSlot({ field }: { field: Field }) {
  const path = String(field.value);
  return (
    <figure className="overflow-hidden rounded-lg border border-dashed border-foreground/15 bg-foreground/[0.03]">
      <div className="flex aspect-[16/7] flex-col items-center justify-center gap-1.5 px-4 text-center">
        <ImageIcon className="size-5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Image preview isn't wired yet. Open it from the game repo.</span>
      </div>
      <figcaption className="flex items-center gap-2 border-t border-dashed border-foreground/15 px-2.5 py-1.5">
        <span className="text-[11px] text-muted-foreground">{field.label}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{path}</code>
        <CopyButton text={path} label={`${field.label} path`} />
      </figcaption>
    </figure>
  );
}

function FieldValue({ field }: { field: Field }) {
  const v = field.value;
  switch (field.kind) {
    case "palette":
      return (
        <span className="flex flex-wrap gap-1.5">
          {(v as string[]).map((c, i) => (
            <span key={`${c}-${i}`} className="flex items-center gap-1 rounded-md border border-foreground/10 bg-background/70 py-0.5 pl-0.5 pr-1.5">
              <span className="size-4 rounded-[4px] ring-1 ring-inset ring-foreground/15" style={{ backgroundColor: c }} aria-hidden />
              <code className="font-mono text-[11px]">{c}</code>
            </span>
          ))}
        </span>
      );
    case "file":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 truncate font-mono">{String(v)}</code>
          <CopyButton text={String(v)} label={`${field.label} path`} />
        </span>
      );
    case "flag":
      return <span className={v ? "" : "font-medium text-warn"}>{v ? "yes" : "no"}</span>;
    case "long":
      return <span className="block max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-foreground/[0.04] px-2 py-1.5">{String(v)}</span>;
    case "json":
      return <code className="break-all font-mono text-[11px]">{JSON.stringify(v)}</code>;
    default:
      return <span className="break-words">{String(v)}</span>;
  }
}

function Commands({ id }: { id: string }) {
  return (
    <div className={cn(box, "overflow-hidden")}>
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2 text-xs">
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Decide in the terminal</span>
        <span className="text-muted-foreground">from the repo root</span>
      </div>
      <ul className="divide-y divide-foreground/10">
        {approvalCommands(id).map((c) => (
          <li key={c.label} className="flex items-center gap-3 px-3 py-1.5">
            <span className="flex w-20 shrink-0 flex-col text-xs">
              <span className="font-medium text-foreground/80">{c.label}</span>
              {c.hint && <span className="text-[10px] text-muted-foreground">{c.hint}</span>}
            </span>
            {/* Wraps instead of truncating: the id at the end is the part that matters. */}
            <code className="min-w-0 flex-1 select-all font-mono [overflow-wrap:anywhere] text-[11px]">{c.cmd}</code>
            <CopyButton text={c.cmd} label={`${c.label.toLowerCase()} command`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The adapter's preview rows as served (non-gate tools, or no "Input" row). */
function PreviewRows({ item }: { item: ApprovalItem }) {
  return (
    <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs">
      {item.preview.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalBody({ item, open = true, live = false }: { item: ApprovalItem; open?: boolean; live?: boolean }) {
  const gate = gateOf(item.tool);
  const input = parseApprovalInput(item);
  const structured = !!input && input.fields.length > 0;
  const images = structured ? input.fields.filter((f) => f.kind === "image") : [];
  const rest = structured ? input.fields.filter((f) => f.kind !== "image") : [];
  const run = item.preview.find((r) => r.label === "Run")?.value ?? item.run?.label;
  return (
    <>
      {gate && <p className="text-sm leading-relaxed text-foreground/85">{gate.note}</p>}
      {images.map((f) => <ImageSlot key={f.key} field={f} />)}
      <div className={box}>
        <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2">
          <code className="font-mono text-xs font-medium">{item.tool}</code>
          <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", policyStyle[item.policy])}>{item.policy}</span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{item.policyNote}</span>
        </div>
        {structured ? (
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 px-3 py-2.5 text-xs">
            {run && <><dt className="text-muted-foreground">Run</dt><dd className="truncate font-mono text-[11px]">{run}</dd></>}
            {rest.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0"><FieldValue field={f} /></dd>
              </div>
            ))}
          </dl>
        ) : <PreviewRows item={item} />}
        {input && !input.complete && (
          <p className="border-t border-foreground/10 px-3 py-2 text-[11px] text-muted-foreground">
            The window only gets the first 200 characters of the input{structured ? ", so some fields may be missing" : ""}. Inspect shows all of it.
          </p>
        )}
        {item.excerpt && <p className="border-t border-foreground/10 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{item.excerpt}</p>}
      </div>
      {item.gated && (
        <p className="flex gap-2 rounded-lg bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />{item.gated}
        </p>
      )}
      {live && open && (
        <>
          <p className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            <Hourglass className="size-3.5 shrink-0" />
            Waiting {waited(item.at)}. Unattended runs give up after {APPROVAL_TIMEOUT_MIN} min by default.
          </p>
          <Commands id={item.id} />
        </>
      )}
    </>
  );
}
