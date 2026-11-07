// Fonts offered in Settings → Appearance. All self-hosted via Fontsource, so they work offline;
// importing the CSS only registers @font-face rules, and a file downloads once a font is used.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/manrope";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/fira-code";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

export interface FontOption { id: string; name: string; family: string; note?: string }

const sans = (name: string) => `"${name}", ui-sans-serif, system-ui, sans-serif`;
const mono = (name: string) => `"${name}", ui-monospace, monospace`;

export const SANS_FONTS: FontOption[] = [
  { id: "geist", name: "Geist", family: sans("Geist Variable"), note: "Default" },
  { id: "inter", name: "Inter", family: sans("Inter Variable") },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", family: sans("IBM Plex Sans Variable") },
  { id: "source-sans-3", name: "Source Sans 3", family: sans("Source Sans 3 Variable") },
  { id: "manrope", name: "Manrope", family: sans("Manrope Variable") },
  { id: "atkinson", name: "Atkinson Hyperlegible", family: sans("Atkinson Hyperlegible Next Variable"), note: "Built for legibility" },
];

export const MONO_FONTS: FontOption[] = [
  { id: "geist-mono", name: "Geist Mono", family: mono("Geist Mono Variable"), note: "Default" },
  { id: "jetbrains-mono", name: "JetBrains Mono", family: mono("JetBrains Mono Variable") },
  { id: "fira-code", name: "Fira Code", family: mono("Fira Code Variable") },
  { id: "ibm-plex-mono", name: "IBM Plex Mono", family: mono("IBM Plex Mono") },
];

export type FontRole = "sans" | "mono";
export type FontChoice = Record<FontRole, { id: string; family: string }>;

// The stored choice keeps the family string too, so index.html can apply it before first paint.
const KEY = "fonts";
const VAR: Record<FontRole, string> = { sans: "--app-font-sans", mono: "--app-font-mono" };
const DEFAULTS: FontChoice = { sans: SANS_FONTS[0], mono: MONO_FONTS[0] };

export function readFonts(): FontChoice {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

export function writeFonts(choice: FontChoice) {
  for (const role of ["sans", "mono"] as const) document.documentElement.style.setProperty(VAR[role], choice[role].family);
  try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch {}
}
