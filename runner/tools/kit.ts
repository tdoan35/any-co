// The tool kit: the types and helpers every capability implementation uses, core or lane
// (runner/tools/lanes/). It imports no capability code, so lane modules can import it without a
// load cycle: impl.ts and registry.ts merge the lanes while they load, so a lane must never import them.
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { NaiveClient } from "../providers.ts";
import type { ImageBlock } from "../types.ts";
import type { Board } from "../board/index.ts";

export interface ToolContext {
  workspace: string; // absolute; the only place workspace_* tools can touch
  naive: NaiveClient | null;
  agent?: string; // set by the runner, for attribution in the ledger
  run_id?: string;
  runsDir?: string; // where runs/ lives (studio_status); defaults to <repo>/runs
  ledgerFile?: string; // studio ledger path (studio_ledger); defaults to <repo>/runs/ledger.jsonl
  gameRepoRoot?: string; // where games/ lives (game_repo); defaults to <repo>/games
  agentsDir?: string; // where agents/ lives (board_create assignee check); defaults to <repo>/agents
  board?: Board; // the studio board for board_* tools; unset → those tools answer an error
}

export interface ToolOutput {
  content: string;
  /** Optional image the model must see next to the text (a ref block; no base64 here). */
  image?: ImageBlock;
  is_error?: boolean;
  cost_micro_usd?: number;
}

export interface ToolImpl {
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
  /**
   * Boolean input field that makes a call a rehearsal (e.g. "dry_run"). When the parsed value is
   * exactly `true`, an "ask" grant runs the call without an approval request (ledgered as an auto
   * decision); anything else goes through the full gate. The field's schema must default to `true`,
   * so an omitted field is the safe case (checked at load, lanes/merge.ts).
   */
  dryRunField?: string;
}

export const MAX_RESULT_CHARS = 40_000;
export function clip(s: string, max = MAX_RESULT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Symlink-safe confinement. Returns the lexically normalised path (so `..` after a symlink is never
// handed to the OS), after checking that what the OS would actually touch stays under the root's
// realpath: the target's realpath when it exists, else the realpath of its deepest existing ancestor.
// A dangling symlink anywhere on the path is refused, since a write would follow it to wherever it points.
// Known limit: check-then-use, so a symlink swapped in between the check and the fs call is not caught.
export function resolveInWorkspace(workspace: string, rel: string): string {
  const p = path.resolve(workspace, rel || ".");
  if (p !== workspace && !p.startsWith(workspace + path.sep)) throw new Error(`path escapes the workspace: ${rel}`);
  const rootReal = realOrNull(workspace) ?? path.resolve(workspace);
  for (let cur = p; ; cur = path.dirname(cur)) {
    const real = realOrNull(cur);
    if (real !== null) {
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`path escapes the workspace through a symlink: ${rel}`);
      return p;
    }
    if (lstatOk(cur)) throw new Error(`path goes through a dangling symlink: ${rel}`);
    if (cur === workspace || path.dirname(cur) === cur) return p; // root not created yet: nothing on disk to follow
  }
}

export function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function lstatOk(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

