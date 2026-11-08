// Board summary for the Flow tab: open/done card counts per assignee, so the window can show where
// the current game sits in the pipeline. Read-only and mechanical (counts only, no card text).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BoardCard, BoardStatus } from "../../runner/board/types.ts";

export type StatusCounts = Record<BoardStatus, number>;
export interface BoardSummary {
  /** Assignee (agent spec name) -> card counts by status. Unassigned cards count under "". */
  byAssignee: Record<string, StatusCounts>;
  /** Finished runs per agent: stages that predate the board (Greenlight ran before it existed) still show done. */
  runsByAgent: Record<string, number>;
}

export function summarizeBoard(cards: BoardCard[], runs: Array<{ agent: string; running: boolean }> = []): BoardSummary {
  const byAssignee: Record<string, StatusCounts> = {};
  for (const c of cards) {
    const k = c.assignee ?? "";
    const row = (byAssignee[k] ??= { todo: 0, doing: 0, blocked: 0, done: 0 });
    row[c.status] += 1;
  }
  const runsByAgent: Record<string, number> = {};
  for (const r of runs) if (!r.running) runsByAgent[r.agent] = (runsByAgent[r.agent] ?? 0) + 1;
  return { byAssignee, runsByAgent };
}

/** Game repos under the games root (dirs with a .git), for card tagging. */
export function knownGames(gamesRoot: string): string[] {
  try {
    return readdirSync(gamesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(gamesRoot, e.name, ".git")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Card ids merged in from another studio's board, tagged with that studio's game (runs/import-*-cards.json sidecars). */
export function importedCardGames(runsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const f of readdirSync(runsDir).filter((n) => /^import-.*-cards\.json$/.test(n))) {
      const j = JSON.parse(readFileSync(path.join(runsDir, f), "utf8")) as { game?: string; cards?: string[] };
      if (typeof j.game === "string") for (const id of j.cards ?? []) out.set(id, j.game);
    }
  } catch {
    /* no sidecar */
  }
  return out;
}

/**
 * The game a board card is about (same rule as T51's game_clone): a "games/<slug>" mention, else a whole-word mention of a known
 * slug, exactly one distinct match; else the import sidecar's game for cards merged from another studio; else null.
 */
export function gameOfCard(card: Pick<BoardCard, "id" | "title" | "body">, games: string[], imported: Map<string, string>): string | null {
  const text = `${card.title}\n${card.body ?? ""}`;
  const pathHits = new Set([...text.matchAll(/\bgames\/([a-z0-9][a-z0-9-]{0,63})\b/g)].map((m) => m[1]).filter((s) => games.includes(s)));
  if (pathHits.size === 1) return [...pathHits][0];
  if (pathHits.size === 0) {
    const words = new Set(games.filter((g) => new RegExp(`(^|[^a-z0-9-])${g.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`, "i").test(text)));
    if (words.size === 1) return [...words][0];
  }
  return imported.get(card.id) ?? null;
}

export interface BoardCardView { id: string; title: string; status: BoardStatus; assignee: string | null; game: string | null; created_at: string; updated_at?: string }

/** Cards for the window (no bodies: titles, status, assignee, game). */
export function boardCards(cards: BoardCard[], games: string[], imported: Map<string, string>): BoardCardView[] {
  return cards.map((c) => ({ id: c.id, title: c.title, status: c.status, assignee: c.assignee, game: gameOfCard(c, games, imported), created_at: c.created_at, updated_at: (c as { updated_at?: string }).updated_at }));
}

/** Card counts by status per game ("" = studio-level / no game). */
export function countsByGame(views: BoardCardView[]): Record<string, StatusCounts> {
  const out: Record<string, StatusCounts> = {};
  for (const v of views) (out[v.game ?? ""] ??= { todo: 0, doing: 0, blocked: 0, done: 0 })[v.status] += 1;
  return out;
}
