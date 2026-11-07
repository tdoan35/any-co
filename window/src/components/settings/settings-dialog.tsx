import { useEffect, useState } from "react";
import { Check, ChevronDown, Minus, Moon, Palette, Plug, Plus, SlidersHorizontal, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/hooks/use-theme";
import { desktop, type FabricDesktop } from "@/lib/desktop";
import { MONO_FONTS, SANS_FONTS, readFonts, writeFonts, type FontChoice, type FontOption, type FontRole } from "@/lib/fonts";
import { chatAgents } from "@/lib/registry";
import { APPROVALS, CONNECTORS, EFFORTS, MODELS, TARGETS, type TargetId } from "@/lib/mock/options";
import { demoMode } from "@/lib/chat/demo";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "connectors", label: "Connectors", icon: Plug },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

// Mock defaults for new sessions. Held for the app's lifetime, not persisted or applied yet.
interface Defaults { agent: string; model: string; effort: string; approval: string; target: TargetId; connectors: Set<string> }
const initialDefaults: Defaults = { agent: "dana", model: "sonnet-5-5", effort: "Medium", approval: "ask", target: demoMode ? "sprite" : "local", connectors: new Set() };
// D7: the demo build hides Full auto and locks "Runs on" to the Sprite sandbox.
const approvals = demoMode ? APPROVALS.filter((a) => a.id !== "auto") : APPROVALS;

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: readonly { id: T; name: string; note?: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" size="sm" aria-label={label} disabled={disabled} className="min-w-40 justify-between gap-2 font-normal">
          {current?.name}<ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onChange(o.id)} className="justify-between gap-3">
            <span>{o.name}{o.note && <span className="ml-2 text-xs text-muted-foreground">{o.note}</span>}</span>
            {o.id === value && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 text-base font-semibold">{children}</h3>;
}

function General({ d, set }: { d: Defaults; set: (p: Partial<Defaults>) => void }) {
  return (
    <section>
      <SectionTitle>General</SectionTitle>
      <p className="mb-2 text-xs text-muted-foreground">Defaults for new sessions. You can still change them per session.</p>
      <div className="divide-y">
        <Row label="Default agent" hint="Who greets you on a new session">
          <Select label="Default agent" value={d.agent} options={chatAgents().map((a) => ({ id: a.id, name: a.name, note: a.role }))} onChange={(agent) => set({ agent })} />
        </Row>
        <Row label="Model">
          <Select label="Model" value={d.model} options={MODELS} onChange={(model) => set({ model })} />
        </Row>
        <Row label="Reasoning effort">
          <Select label="Reasoning effort" value={d.effort} options={EFFORTS.map((e) => ({ id: e, name: e }))} onChange={(effort) => set({ effort })} />
        </Row>
        <Row label="Approvals" hint={approvals.find((a) => a.id === d.approval)?.note}>
          <Select label="Approvals" value={d.approval} options={approvals} onChange={(approval) => set({ approval })} />
        </Row>
        <Row label="Runs on" hint={demoMode ? "Locked to the Sprite sandbox for the demo" : "Where agents execute code and tools"}>
          <Select label="Runs on" value={d.target} options={TARGETS} onChange={(target) => set({ target })} disabled={demoMode} />
        </Row>
      </div>
    </section>
  );
}

function FontPicker({ label, hint, fonts, value, sample, onChange }: {
  label: string; hint: string; fonts: FontOption[]; value: string; sample: string; onChange: (f: FontOption) => void;
}) {
  return (
    <div className="py-3">
      <div className="mb-2.5">
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {fonts.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={value === f.id} onClick={() => onChange(f)}
            className={cn("flex min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === f.id && "border-foreground/40 bg-foreground/5 ring-1 ring-foreground/40")}>
            <span className="text-xl leading-tight" style={{ fontFamily: f.family }}>{sample}</span>
            <span className="text-xs leading-snug" style={{ fontFamily: f.family }}>{f.name}</span>
            {f.note && <span className="-mt-1 text-[11px] text-muted-foreground">{f.note}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function Typography() {
  const [fonts, setFonts] = useState<FontChoice>(readFonts);
  const pick = (role: FontRole) => (f: FontOption) => {
    const next = { ...fonts, [role]: { id: f.id, family: f.family } };
    setFonts(next);
    writeFonts(next);
  };
  return (
    <>
      <h4 className="mt-6 mb-1 text-sm font-semibold">Typography</h4>
      <div className="divide-y">
        <FontPicker label="Interface font" hint="Used for all text in the app" fonts={SANS_FONTS} value={fonts.sans.id} sample="Ag" onChange={pick("sans")} />
        <FontPicker label="Code font" hint="Used for code, tool names and IDs" fonts={MONO_FONTS} value={fonts.mono.id} sample="{ 0O1l }" onChange={pick("mono")} />
      </div>
    </>
  );
}

function Appearance() {
  const { dark, setTheme } = useTheme();
  const themes = [
    { dark: false, label: "Light", icon: Sun },
    { dark: true, label: "Dark", icon: Moon },
  ];
  return (
    <section>
      <SectionTitle>Appearance</SectionTitle>
      <div className="divide-y">
        <Row label="Theme">
          <div role="radiogroup" aria-label="Theme" className="flex gap-1 rounded-lg bg-muted p-[3px]">
            {themes.map((t) => (
              <button key={t.label} type="button" role="radio" aria-checked={dark === t.dark} onClick={() => setTheme(t.dark)}
                className={cn("flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  dark === t.dark && "bg-background text-foreground shadow-sm dark:bg-input/30")}>
                <t.icon className="size-3.5" />{t.label}
              </button>
            ))}
          </div>
        </Row>
        {desktop && (
          <Row label="Zoom" hint="Also in the title bar menu">
            <ZoomControl app={desktop.app} />
          </Row>
        )}
      </div>
      <Typography />
    </section>
  );
}

function ZoomControl({ app }: { app: FabricDesktop["app"] }) {
  const [zoom, setZoom] = useState<Awaited<ReturnType<typeof app.zoom>> | null>(null);
  useEffect(() => {
    const refresh = () => { app.zoom().then(setZoom); };
    refresh();
    // Zooming resizes the viewport, so this also catches shortcuts and the title bar menu.
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [app]);
  const run = (command: "zoom-in" | "zoom-out" | "zoom-reset") => { app.command(command); app.zoom().then(setZoom); };
  const pct = zoom ? Math.round(zoom.factor * 100) : 100;
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" className="size-8" aria-label="Zoom out" disabled={!!zoom && zoom.factor <= zoom.min} onClick={() => run("zoom-out")}><Minus /></Button>
      <output aria-live="polite" aria-label="Zoom level" className="flex h-8 w-16 items-center justify-center rounded-md border bg-muted/40 text-sm tabular-nums">{pct}%</output>
      <Button variant="outline" size="icon" className="size-8" aria-label="Zoom in" disabled={!!zoom && zoom.factor >= zoom.max} onClick={() => run("zoom-in")}><Plus /></Button>
      <Button variant="outline" size="sm" className="ml-1 h-8" disabled={pct === 100} onClick={() => run("zoom-reset")}>Reset</Button>
    </div>
  );
}

function Connectors({ d, set }: { d: Defaults; set: (p: Partial<Defaults>) => void }) {
  const toggle = (id: string) => {
    const next = new Set(d.connectors);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ connectors: next });
  };
  return (
    <section>
      <SectionTitle>Connectors</SectionTitle>
      <p className="mb-2 text-xs text-muted-foreground">Connected by default in new sessions.</p>
      <div className="divide-y">
        {CONNECTORS.map((c) => (
          <Row key={c.id} label={c.name} hint={c.note}>
            <Switch checked={d.connectors.has(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={c.name} />
          </Row>
        ))}
      </div>
    </section>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [section, setSection] = useState<SectionId>("general");
  // Lives outside DialogContent so values survive closing and reopening.
  const [defaults, setDefaults] = useState(initialDefaults);
  const set = (p: Partial<Defaults>) => setDefaults((d) => ({ ...d, ...p }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(520px,calc(100svh-var(--titlebar-height)-4rem))] w-[calc(100vw-2rem)] max-w-3xl! gap-0 overflow-hidden p-0">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-3 max-sm:w-14 max-sm:px-2">
          <DialogHeader className="mb-3 px-2 pt-1 max-sm:sr-only">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription className="sr-only">App preferences and defaults for new sessions</DialogDescription>
          </DialogHeader>
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => setSection(s.id)} aria-current={section === s.id ? "page" : undefined} aria-label={s.label}
              className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center",
                section === s.id && "bg-foreground/5 font-medium text-foreground")}>
              <s.icon className="size-4 shrink-0" /><span className="max-sm:hidden">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-width:thin]">
          {section === "general" && <General d={defaults} set={set} />}
          {section === "appearance" && <Appearance />}
          {section === "connectors" && <Connectors d={defaults} set={set} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
