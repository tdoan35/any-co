// Local board backend: append-only JSONL at runs/board.jsonl (override: explicit path or
// STUDIO_BOARD_FILE), state = fold over events. Crash-safe by construction — a restart reads
// the log back; nothing is derived that isn't in the file.
// Single-writer assumptions: the dispatcher owns status moves, agents append creates/comments.
// Appends are one line each (O_APPEND); the fold is first-wins on a duplicate `key`, so a
// replayed create cannot duplicate a card.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoardError, type Board, type BoardCard, type BoardComment, type BoardCreate, type BoardStatus, type BoardUpdate } from "./types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BOARD_FILE = process.env.STUDIO_BOARD_FILE ?? path.join(ROOT, "runs", "board.jsonl");

type Claim = NonNullable<BoardCard["claim"]>;
type Event =
  | { t: "created"; at: string; card: BoardCard; key?: string }
  | { t: "updated"; at: string; id: string; status?: BoardStatus; note?: string; body?: string; title?: string; blocked_by?: string[]; claim?: Claim }
  | { t: "commented"; at: string; comment: BoardComment };

interface State {
  cards: Map<string, BoardCard>;
  comments: Map<string, BoardComment[]>;
  keys: Map<string, string>; // key -> card id (first create wins)
}
/** The healed view: a blocked card whose blockers all reached done reads as todo (Naïve heals
 *  on the next read). Unlike Naïve's wire card, `blocked_by` keeps the done ids too — the
 *  dispatcher needs the original edges to hand the assignee its blockers' done notes. A blocked
 *  card with an empty list is stuck on the world and stays blocked. Cards sort by creation. */
export function healed(cards: Map<string, BoardCard>): BoardCard[] {
  return [...cards.values()]
    .map((c) =>
      c.status === "blocked" && c.blocked_by.length > 0 && c.blocked_by.every((id) => cards.get(id)?.status === "done")
        ? { ...c, status: "todo" as const }
        : c,
    )
    .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)));
}

export class LocalBoard implements Board {
  constructor(private file: string = DEFAULT_BOARD_FILE) {}

  private load(): State {
    const s: State = { cards: new Map(), comments: new Map(), keys: new Map() };
    if (!existsSync(this.file)) return s;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        continue; // a torn last line (crash mid-append) must not lose the board
      }
      if (e.t === "created") {
        if (s.cards.has(e.card.id)) continue;
        s.cards.set(e.card.id, e.card);
        if (e.key) s.keys.set(e.key, e.card.id);
      } else if (e.t === "updated") {
        const c = s.cards.get(e.id);
        if (!c) continue;
        // the fold is the source of truth (N2): done is terminal, and a claim that did not win —
        // the card already held, or not claimable (todo, or healable blocked) when it landed — is
        // ignored entirely, so a writer stalled between load and append cannot reopen a card.
        if (c.status === "done") continue;
        if (e.claim) {
          const healable = c.status === "blocked" && c.blocked_by.length > 0 && c.blocked_by.every((id) => s.cards.get(id)?.status === "done");
          if (c.claim || !(c.status === "todo" || healable)) continue;
        }
        if (e.status !== undefined) c.status = e.status;
        if (e.note !== undefined) c.note = e.note;
        if (e.body !== undefined) c.body = e.body;
        if (e.title !== undefined) c.title = e.title;
        if (e.blocked_by !== undefined) c.blocked_by = e.blocked_by;
        // claims are first-wins in file order (the re-fold/nonce pattern from tools/approvals):
        // two writers may both append; only the one whose nonce stuck holds the card.
        if (e.claim) c.claim = e.claim;
        if (e.status !== undefined && e.status !== "doing") c.claim = null;
        c.updated_at = e.at;
      } else if (e.t === "commented") {
        const list = s.comments.get(e.comment.card_id) ?? [];
        list.push(e.comment);
        s.comments.set(e.comment.card_id, list);
      }
    }
    return s;
  }

  private append(e: Event): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }

  private view(s: State, id: string): BoardCard {
    const card = healed(s.cards).find((c) => c.id === id);
    if (!card) throw new BoardError("unknown_card", `no card ${id} on this board`);
    return card;
  }

  async create(c: BoardCreate): Promise<{ card: BoardCard; created: boolean }> {
    const s = this.load();
    if (c.key && s.keys.has(c.key)) return { card: this.view(s, s.keys.get(c.key)!), created: false };
    if (c.blocked_by?.length) {
      const missing = c.blocked_by.filter((id) => !s.cards.has(id));
      if (missing.length) throw new BoardError("unknown_blocker", `blocked_by names unknown card(s): ${missing.join(", ")}`);
    }
    const now = new Date().toISOString();
    const card: BoardCard = {
      id: `crd_${randomUUID().slice(0, 12)}`,
      title: c.title,
      body: c.body ?? "",
      note: null,
      status: c.status ?? (c.blocked_by?.length ? "blocked" : "todo"),
      assignee: c.assignee ?? null,
      blocked_by: c.blocked_by ?? [],
      upstream: c.blocked_by ?? [],
      created_at: now,
      updated_at: now,
    };
    this.append({ t: "created", at: now, card, key: c.key });
    return { card, created: true };
  }

  async get(cardId: string): Promise<BoardCard> {
    return this.view(this.load(), cardId);
  }

  async list(): Promise<BoardCard[]> {
    return healed(this.load().cards);
  }

  async update(cardId: string, patch: BoardUpdate): Promise<BoardCard> {
    const s = this.load();
    const raw = s.cards.get(cardId);
    if (!raw) throw new BoardError("unknown_card", `no card ${cardId} on this board`);
    if (raw.status === "done") throw new BoardError("already_resolved", `card ${cardId} is done; make a new card instead`);
    const view = this.view(s, cardId);
    if (patch.status === "done" && !(patch.note ?? raw.note)) {
      throw new BoardError("missing_note", "a done needs a note: pass one saying what was done and what is left");
    }
    if (patch.status === "doing") {
      // a claim takes only a todo card, and only if our claim is the first in file order (R2)
      if (view.status !== "todo") throw new BoardError("already_claimed", `card ${cardId} is ${view.status}, not todo; only a todo card can be claimed`);
      if (raw.assignee) {
        const holder = [...s.cards.values()].find((c) => c.id !== cardId && c.status === "doing" && c.assignee === raw.assignee);
        if (holder) throw new BoardError("already_working", `${raw.assignee} is already doing card ${holder.id}`);
      }
      const claim: Claim = {
        nonce: randomUUID(),
        pid: patch.claim?.pid ?? process.pid,
        host: patch.claim?.host ?? "unknown",
        run_id: patch.claim?.run_id,
        at: new Date().toISOString(),
      };
      this.append({ t: "updated", at: claim.at, id: cardId, status: "doing", note: raw.note ?? undefined, body: raw.body, title: raw.title, blocked_by: raw.blocked_by, claim });
      const reread = this.load().cards.get(cardId); // re-fold: did our nonce stick?
      if (reread?.claim?.nonce !== claim.nonce) throw new BoardError("already_claimed", `another claim on card ${cardId} landed first`);
      return { ...reread };
    }
    if (patch.body !== undefined) raw.body = patch.body;
    if (patch.title !== undefined) raw.title = patch.title;
    if (patch.note !== undefined) raw.note = patch.note;
    if (patch.status !== undefined && patch.status !== view.status) {
      raw.status = patch.status;
      raw.claim = null;
      // a block keeps only OPEN blockers (R1): the done ones never explain a failure, and
      // leaving them in lets heal-on-read reopen a card the dispatcher just blocked.
      if (patch.status === "blocked") {
        raw.blocked_by = raw.blocked_by.filter((id) => s.cards.get(id)?.status !== "done");
      }
    }
    const now = new Date().toISOString();
    raw.updated_at = now;
    this.append({ t: "updated", at: now, id: cardId, status: raw.status, note: raw.note ?? undefined, body: raw.body, title: raw.title, blocked_by: raw.blocked_by });
    return { ...raw };
  }

  async comment(cardId: string, body: string, author: string): Promise<BoardComment> {
    const s = this.load();
    if (!s.cards.has(cardId)) throw new BoardError("unknown_card", `no card ${cardId} on this board`);
    const comment: BoardComment = {
      id: `cmt_${randomUUID().slice(0, 12)}`,
      card_id: cardId,
      author,
      body,
      created_at: new Date().toISOString(),
    };
    this.append({ t: "commented", at: comment.created_at, comment });
    return comment;
  }

  async comments(cardId: string): Promise<BoardComment[]> {
    const s = this.load();
    if (!s.cards.has(cardId)) throw new BoardError("unknown_card", `no card ${cardId} on this board`);
    return s.comments.get(cardId) ?? [];
  }
}
