// Supersede (T38): a replacement card takes over an old card's place in the dependency graph.
// When a run hits its limits or blocks and a NEW card replaces the old one, every card blocked_by the old
// card would otherwise wait forever. supersede() re-points every open dependent from the old id to the new
// one FIRST (so nothing heals early), then closes the old card as done "superseded by <new>".
// The new card's body starts with a `supersedes: <old id>` line, so a supersede interrupted half-way (crash,
// refused write) is finished by the dispatcher's next pass (completeSupersedes). Both backends.
import { BoardError, type Board, type BoardCard } from "./types.ts";

const MARKER = /^supersedes: (crd_[A-Za-z0-9_-]{1,64})\n\n/;

/** The body a replacement card is created with: the marker line, then the brief. */
export const supersedesBody = (oldId: string, body = ""): string => `supersedes: ${oldId}\n\n${body}`;
/** The card this card supersedes, from its body marker; null when it supersedes nothing. */
export const supersedesOf = (card: Pick<BoardCard, "body">): string | null => MARKER.exec(card.body)?.[1] ?? null;

/** Refuse a supersede the board can't honour, before any card is created. */
export function supersedeRefusal(old: BoardCard | undefined, oldId: string): string | null {
  if (!old) return `supersedes names an unknown card: ${oldId}`;
  if (old.status === "doing") return `card ${oldId} is doing (a run holds it); supersede it once it has blocked or finished`;
  if (old.status === "done") return `card ${oldId} is already done; nothing waits on it, so there is nothing to supersede`;
  return null;
}

export interface SupersedeResult { old: string; by: string; repointed: string[]; closed: boolean }

/** Re-point every open dependent of `oldId` to `newId`, then close `oldId` done (unless it is doing or already done). Idempotent. */
export async function supersede(board: Board, oldId: string, newId: string): Promise<SupersedeResult> {
  if (oldId === newId) throw new BoardError("unknown_blocker", "a card cannot supersede itself");
  const cards = await board.list();
  const repointed: string[] = [];
  for (const c of cards) {
    if (c.id === newId || c.id === oldId || c.status === "done") continue;
    if (!c.blocked_by.includes(oldId) && !(c.upstream ?? []).includes(oldId)) continue;
    await board.update(c.id, { repoint: { from: oldId, to: newId } });
    repointed.push(c.id);
  }
  const old = cards.find((c) => c.id === oldId);
  let closed = false;
  if (old && old.status !== "done" && old.status !== "doing") {
    await board.update(oldId, { status: "done", note: `superseded by ${newId}` });
    closed = true;
  }
  return { old: oldId, by: newId, repointed, closed };
}

/**
 * Dispatcher safety net: finish every supersede the board shows as incomplete: a card whose marker names an
 * old card that is still open (not done), or still has open dependents. A doing old card is left for later.
 */
export async function completeSupersedes(board: Board, log?: (m: string) => void): Promise<SupersedeResult[]> {
  const cards = await board.list();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const done: SupersedeResult[] = [];
  for (const c of cards) {
    const oldId = supersedesOf(c);
    if (!oldId || oldId === c.id) continue;
    const old = byId.get(oldId);
    if (!old || old.status === "doing") continue;
    const stranded = cards.some((d) => d.id !== c.id && d.status !== "done" && d.blocked_by.includes(oldId));
    if (old.status === "done" && !stranded) continue;
    try {
      const r = await supersede(board, oldId, c.id);
      if (r.repointed.length || r.closed) {
        log?.(`supersede ${oldId} → ${c.id}: re-pointed ${r.repointed.length} card(s)${r.closed ? ", closed the old card" : ""}`);
        done.push(r);
      }
    } catch (e) {
      log?.(`supersede ${oldId} → ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return done;
}
