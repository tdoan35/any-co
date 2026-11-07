// Naïve board backend: the same Board interface over client.board.cards.* on the board owned
// by the Studio Head's Naïve agent. STUDIO_BOARD_REF addresses it (a brd_ id or the owner's
// agt_ id; a board with no cards has never told anyone its brd_ id).
//
// NEVER put a local agent's name in `assignee` on this backend. On Naïve, assignment IS the
// wake: a todo card with an assignee, no open blocker and an idle assignee starts a hosted
// session of that agent in the same request — the response already carries woken_session_id
// (verified Nov 7, usenaive.ai/docs/team/board.md "Assigning a card starts the teammate on
// it"). Local agents run on our runner, not hosted, so the local assignee travels in a
// structured header at the top of the card body instead:
//     local-assignee: <agent name>
// and `assignee` stays null on the wire. Healing, key idempotency, one-doing-per-assignee and
// the done-needs-a-note rule are enforced server-side; this class only maps shapes and keeps
// `update` from ever writing `assignee` (a reassignment resets the wake). One divergence from
// the local backend: Naïve strips done ids out of `blocked_by` on read, so a healed card here
// no longer carries the edges — the dispatcher still starts it, but without upstream notes.
import { BoardError, type Board, type BoardCard, type BoardComment, type BoardCreate, type BoardUpdate } from "./types.ts";

const HEADER = "local-assignee: ";

/** A Naïve board card on the wire (SDK dist/index.d.ts:5598+); the fields we read. */
export interface NaiveCard {
  id: string;
  title: string;
  body: string;
  note: string | null;
  status: BoardCard["status"];
  assignee: string | null;
  blocked_by: string[];
  created_at: string;
  updated_at: string;
}

/** The slice of the Naïve client the board uses — structural, so tests can fake it and the
 *  real client (providers.NaiveClient) satisfies it without a cast. */
export interface BoardClient {
  board: {
    cards: {
      list: (ref: string, query?: { limit?: number; after?: string }) => Promise<{ data: NaiveCard[]; has_more: boolean; next_cursor: string | null }>;
      create: (ref: string, body: { title: string; body?: string; status?: BoardCard["status"]; assignee?: string | null; blocked_by?: string[]; key?: string }) => Promise<NaiveCard>;
      get: (ref: string, cardId: string) => Promise<NaiveCard>;
      update: (ref: string, cardId: string, body: { title?: string; body?: string; status?: BoardCard["status"]; note?: string; assignee?: string | null; blocked_by?: string[] }) => Promise<NaiveCard>;
      comments: (ref: string, cardId: string, query?: { limit?: number; after?: string }) => Promise<{ data: BoardComment[]; has_more: boolean; next_cursor: string | null }>;
      comment: (ref: string, cardId: string, body: { body: string }) => Promise<BoardComment>;
    };
  };
}

/** Naïve card JSON → BoardCard, pulling the local-assignee header back out of the body. */
function decode(raw: NaiveCard): BoardCard {
  let assignee = raw.assignee;
  let body = raw.body;
  if (body.startsWith(HEADER)) {
    const rest = body.slice(HEADER.length);
    const end = rest.indexOf("\n\n");
    if (end !== -1) {
      assignee = rest.slice(0, end);
      body = rest.slice(end + 2);
    }
  }
  return {
    id: raw.id,
    title: raw.title,
    body,
    note: raw.note,
    status: raw.status,
    assignee,
    blocked_by: raw.blocked_by ?? [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/** Naïve names its board-tool refusals; a type-checked predicate (not a cast) picks the ones
 *  BoardError carries, so a renamed code on the wire can never sneak past the compiler. */
function isRefusal(code: string): code is BoardError["code"] {
  return code === "unknown_card" || code === "missing_note" || code === "already_resolved" || code === "already_working";
}

/** Surface the server's named refusals as BoardError; anything else propagates as thrown. */
function rethrow(e: unknown): never {
  if (e && typeof e === "object" && "code" in e) {
    const code = e.code;
    if (typeof code === "string" && isRefusal(code)) {
      throw new BoardError(code, e instanceof Error ? e.message : code);
    }
  }
  throw e;
}

export class NaiveBoard implements Board {
  constructor(private client: BoardClient, private ref: string) {}

  async create(c: BoardCreate): Promise<{ card: BoardCard; created: boolean }> {
    try {
      const body = c.assignee ? `${HEADER}${c.assignee}\n\n${c.body ?? ""}` : (c.body ?? "");
      // assignee: null always — see the file comment; the SDK create is idempotent by `key`.
      const raw = await this.client.board.cards.create(this.ref, {
        title: c.title,
        body,
        assignee: null,
        blocked_by: c.blocked_by,
        key: c.key,
        status: c.status,
      });
      // The server answers 201 for a new card and 200 for one a key already made, but the SDK
      // does not surface the status; `created` is advisory here (idempotency is server-side).
      return { card: decode(raw), created: true };
    } catch (e) {
      rethrow(e);
    }
  }

  async get(cardId: string): Promise<BoardCard> {
    try {
      return decode(await this.client.board.cards.get(this.ref, cardId));
    } catch (e) {
      rethrow(e);
    }
  }

  async list(): Promise<BoardCard[]> {
    const out: BoardCard[] = [];
    let after: string | undefined;
    do {
      const page = await this.client.board.cards.list(this.ref, { limit: 100, after });
      out.push(...page.data.map(decode));
      after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (after);
    return out.sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)));
  }

  async update(cardId: string, patch: BoardUpdate): Promise<BoardCard> {
    try {
      // No assignee ever: writing it resets the card's wake (docs/team/board.md, PATCH row).
      const raw = await this.client.board.cards.update(this.ref, cardId, {
        status: patch.status,
        note: patch.note,
        body: patch.body,
        title: patch.title,
      });
      return decode(raw);
    } catch (e) {
      rethrow(e);
    }
  }

  async comment(cardId: string, body: string, _author: string): Promise<BoardComment> {
    // The server signs the comment with the caller's principal; our author value is local-only.
    try {
      return await this.client.board.cards.comment(this.ref, cardId, { body });
    } catch (e) {
      rethrow(e);
    }
  }

  async comments(cardId: string): Promise<BoardComment[]> {
    try {
      const page = await this.client.board.cards.comments(this.ref, cardId, { limit: 100 });
      return page.data;
    } catch (e) {
      rethrow(e);
    }
  }
}
