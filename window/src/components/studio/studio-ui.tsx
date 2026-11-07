import type { ComponentType, ReactNode } from "react";

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

/** Two-option button group with a sliding indicator (same look as the chat page's Agents / Teams). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="tablist" className="relative grid h-8 grid-flow-col auto-cols-fr rounded-lg bg-muted/80 p-[3px] text-sm backdrop-blur">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-[3px] left-[3px] rounded-md bg-background shadow-sm transition-transform duration-300 ease-out dark:border dark:border-input dark:bg-input/30"
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className="relative z-10 rounded-md px-5 font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:text-foreground"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
