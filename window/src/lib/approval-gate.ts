// Display rules for the approval gate's pending requests (runs/approvals.jsonl, served as Weave
// approval items). Harness knowledge only: which gated tools exist and how to decide them from
// the terminal. Nothing here knows about the game.
import type { ApprovalItem } from "@fabric/contracts";

export interface Gate {
  /** What the decision is, in Ty's words. */
  label: string;
  /** One line on what approving does. */
  note: string;
}

/** Gated (`ask`) tools that are human checkpoints. Unknown tools fall back to the item's own title. */
export const GATES: Record<string, Gate> = {
  art_signoff: {
    label: "Art sign-off",
    note: "Style bible and anchor contact sheet, before batch art generation. Approving lets batch generation start.",
  },
  itch_push: {
    label: "Public release: itch.io push",
    note: "Uploads a build to an itch.io channel with butler. A dry run never asks; this one is real.",
  },
  site_deploy: {
    label: "Public release: studio site deploy",
    note: "Deploys the web build and marketing pages to the studio site, or rolls back to an earlier deployment.",
  },
  email_send: {
    label: "Outreach email",
    note: "Sends one email from the studio inbox to an outside address.",
  },
};

export const gateOf = (tool: string): Gate | undefined => GATES[tool];

/** The inbox and detail title: the checkpoint name when the tool is a known gate. */
export const approvalTitle = (item: Pick<ApprovalItem, "tool" | "title">) => gateOf(item.tool)?.label ?? item.title;

/** Unattended runs give up on a request after this long (runner `--approval-timeout-min` default). */
export const APPROVAL_TIMEOUT_MIN = 30;

export interface Command { label: string; cmd: string; hint?: string }

/** The exact terminal commands for one request. Deny needs a note (the CLI refuses without one). */
export function approvalCommands(id: string): Command[] {
  return [
    { label: "Inspect", cmd: `npm run approvals -- show ${id}`, hint: "full input" },
    { label: "Approve", cmd: `npm run approvals -- approve ${id} --note ""`, hint: "note optional" },
    { label: "Deny", cmd: `npm run approvals -- deny ${id} --note ""`, hint: "note required" },
  ];
}

export type FieldKind = "image" | "file" | "palette" | "text" | "long" | "flag" | "json";
export interface Field { key: string; label: string; kind: FieldKind; value: unknown }
export interface ParsedInput {
  fields: Field[];
  /** The adapter's preview string as served. */
  raw: string;
  /** False when the JSON was cut short and the fields were salvaged from the complete pairs. */
  complete: boolean;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const FILE = /^[\w.\-/]+\.[a-z0-9]{1,5}$/i;
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** "contact_sheet" -> "Contact sheet". */
export const fieldLabel = (key: string) => {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function fieldKind(value: unknown): FieldKind {
  if (typeof value === "boolean") return "flag";
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && HEX.test(v))) return "palette";
  if (typeof value === "string") {
    if (IMAGE.test(value) && FILE.test(value)) return "image";
    if (FILE.test(value) && value.includes("/")) return "file";
    return value.length > 120 || value.includes("\n") ? "long" : "text";
  }
  if (typeof value === "number") return "text";
  return "json";
}

const toFields = (o: Record<string, unknown>): Field[] =>
  Object.entries(o).map(([key, value]) => ({ key, label: fieldLabel(key), kind: fieldKind(value), value }));

/** Complete `"key": value` pairs (strings, numbers, booleans, null, flat arrays) from a JSON prefix. */
const PAIR = /"([A-Za-z_][\w-]*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\[[^[\]{}]*\])/g;

/** Reads the request input from the approval's "Input" preview row. The adapter cuts it at 200
 *  characters, so a long input is salvaged pair by pair and marked incomplete. */
export function parseApprovalInput(item: Pick<ApprovalItem, "preview">): ParsedInput | undefined {
  const raw = item.preview.find((r) => r.label === "Input")?.value;
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return { fields: toFields(v as Record<string, unknown>), raw, complete: true };
    return { fields: [{ key: "input", label: "Input", kind: fieldKind(v), value: v }], raw, complete: true };
  } catch {
    const salvaged: Record<string, unknown> = {};
    for (const m of raw.matchAll(PAIR)) {
      try { salvaged[m[1]] = JSON.parse(m[2]); } catch { /* skip a pair that only looked complete */ }
    }
    return { fields: toFields(salvaged), raw, complete: false };
  }
}
