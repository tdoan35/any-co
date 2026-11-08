import { useCallback, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared look for the Studio-style pages (Agent Studio, Teams). */
export const EASE = { duration: 0.45, ease: [0.22, 1, 0.36, 1] } as const;
export const surface = "border border-foreground/10 bg-background/50 shadow-sm backdrop-blur-md";
export const panel = "rounded-xl border border-foreground/10 bg-background/50";
export const pill = "rounded-full bg-foreground/5 px-1.5 py-px text-[10px] font-medium text-muted-foreground";

export function SectionHead({ title, count, hint }: { title: string; count?: number; hint: string }) {
  return (
    <div className="mb-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="rounded-full bg-foreground/5 px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function Group({ icon: Icon, title, count, children }: { icon?: ComponentType<{ className?: string }>; title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}{title}
        {count !== undefined && <span className="tabular-nums">· {count}</span>}
      </h3>
      {children}
    </section>
  );
}

export const PANEL_PATTERN = {
  dots: "bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_18%,transparent)_1px,transparent_1px)] bg-[size:20px_20px]",
  grid: "bg-[linear-gradient(color-mix(in_oklab,var(--foreground)_8%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_8%,transparent)_1px,transparent_1px)] bg-[size:24px_24px]",
};

/** Inset panel under a page header: a gap around the content and a rounded, translucent border. */
export function InsetPanel({ children, pattern = "dots", wide }: { children: ReactNode; pattern?: "dots" | "grid"; wide?: boolean }) {
  return (
    <div className="min-h-0 flex-1 animate-in fade-in slide-in-from-bottom-3 p-4 pt-3 duration-500 ease-out fill-mode-backwards">
      <div className={`h-full overflow-y-auto rounded-2xl border border-foreground/10 bg-background/20 ${PANEL_PATTERN[pattern]} px-8 py-8 shadow-sm backdrop-blur-xl`}>
        <div className={`mx-auto ${wide ? "" : "max-w-[880px]"} animate-in fade-in slide-in-from-bottom-2 delay-150 duration-500 ease-out fill-mode-backwards`}>{children}</div>
      </div>
    </div>
  );
}

export const headerButton = "h-8 bg-background/60 backdrop-blur hover:bg-background/90 dark:bg-background/40 dark:hover:bg-background/70";

/** Header title entrance: fades in and slides a few pixels from the left. */
export const headerTitle = "animate-in fade-in slide-in-from-left-2 font-medium duration-500 fill-mode-backwards";

const segmentTrack = "relative h-8 rounded-lg bg-muted/80 p-[3px] text-sm backdrop-blur";
const segmentIndicator = "pointer-events-none absolute top-[3px] bottom-[3px] rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30";
const segmentTab = "relative z-10 rounded-md font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:text-foreground";

/** Button group with a sliding indicator. Equal slices for a short switch; `fit` sizes each option to its label. */
export function Segmented<T extends string>({ value, options, onChange, fit = false, className }: {
  value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; fit?: boolean; className?: string;
}) {
  if (fit) return <FittedSegmented value={value} options={options} onChange={onChange} className={className} />;
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="tablist" className={cn(segmentTrack, "grid grid-flow-col auto-cols-fr", className)}>
      <span
        aria-hidden
        className={cn(segmentIndicator, "left-[3px] transition-transform duration-300 ease-out")}
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(segmentTab, "px-5")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One segment per label, wide enough for the full name. The row scrolls inside the bar when it does not fit. */
function FittedSegmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const key = options.map((o) => `${o.value}:${o.label}`).join("|");

  const place = useCallback((scroll: boolean) => {
    const list = listRef.current;
    const btn = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !btn) return;
    const left = btn.offsetLeft;
    const width = btn.offsetWidth;
    setBox((prev) => (prev && prev.left === left && prev.width === width ? prev : { left, width }));
    if (!scroll) return;
    const right = left + width;
    const pad = 3;
    if (left - pad < list.scrollLeft) list.scrollLeft = Math.max(0, left - pad);
    else if (right + pad > list.scrollLeft + list.clientWidth) list.scrollLeft = right + pad - list.clientWidth;
  }, []);

  useLayoutEffect(() => { place(true); }, [place, value, key]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(list);
    return () => ro.disconnect();
  }, [place, value, key]);

  return (
    <div
      ref={listRef}
      role="tablist"
      className={cn(segmentTrack, "flex min-w-0 items-stretch overflow-x-auto text-xs", className)}
    >
      <span
        aria-hidden
        className={cn(segmentIndicator, "transition-[left,width] duration-300 ease-out")}
        style={box ? { left: box.left, width: box.width } : { width: 0, opacity: 0 }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(segmentTab, "h-full shrink-0 whitespace-nowrap px-2")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
