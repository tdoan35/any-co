// The studio board: one interface, two backends, Naïve's semantics.
// Facts verified Nov 7 against the SDK types (dist/index.d.ts:3631-3673, 5532-5684) and
// https://usenaive.ai/docs/team/board.md — mirrored here so both backends read the same:
// - statuses are fixed: todo | doing | blocked | done; `done` is terminal and needs a note
//   (on the move or already on the card), `blocked_by` carries the reason a card waits,
//   a blocked card whose blockers all reach done is healed back to todo on read,
//   `key` makes create idempotent (same key answers the card it made the first time),
//   one `doing` card per assignee.

export type BoardStatus = "todo" | "doing" | "blocked" | "done";

export interface BoardCard {
  id: string;
  title: string;
  body: string; // the brief
  note: string | null; // what the holder wrote back
  status: BoardStatus;
  assignee: string | null; // agent name (Naïve: a name, not an agt_ id; null = unassigned)
  blocked_by: string[]; // card ids it waits on (done ones stripped in the healed view)
  created_at: string;
  updated_at: string;
}

export interface BoardComment {
  id: string;
  card_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface BoardCreate {
  title: string;
  body?: string;
  assignee?: string | null;
  blocked_by?: string[];
  /** Idempotency (≤128 chars on Naïve): re-creating with the same key answers the existing card. */
  key?: string;
  /** Default todo; on Naïve a card created with a blocked_by starts blocked. */
  status?: BoardStatus;
}

/** A move is {status} plus what the holder wrote back. No assignee here: on Naïve, writing
 *  `assignee` resets the card's wake (see naive.ts), and the dispatcher never reassigns. */
export interface BoardUpdate {
  status?: BoardStatus;
  note?: string;
  body?: string;
  title?: string;
}

export interface Board {
  /** Idempotent by `key`. `created` is false when the key already made this card. */
  create(c: BoardCreate): Promise<{ card: BoardCard; created: boolean }>;
  get(cardId: string): Promise<BoardCard>;
  /** All cards in the healed view: done blockers stripped, healable cards read as todo. */
  list(): Promise<BoardCard[]>;
  update(cardId: string, patch: BoardUpdate): Promise<BoardCard>;
  comment(cardId: string, body: string, author: string): Promise<BoardComment>;
  comments(cardId: string): Promise<BoardComment[]>;
}

/** Refusals, named like the hosted board tools' refusals so a caller reads the word and acts. */
export class BoardError extends Error {
  constructor(
    readonly code: "unknown_card" | "unknown_blocker" | "missing_note" | "already_resolved" | "already_working",
    message: string,
  ) {
    super(message);
  }
}
