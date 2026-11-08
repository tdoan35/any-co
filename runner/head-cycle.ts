// The Studio Head's cycle turn (T10): the fixed, mechanical task the studio loop gives it on its
// cadence, and the auto-start trigger. Mechanism only: no game, genre, or design content here.
import { read as ledgerRead, LEDGER_FILE } from "../tools/ledger/ledger.ts";

export const HEAD_TASK = `Studio cycle. Work from your tools only, in this order:
1. Look: board_list (board_get on every doing and blocked card), studio_runs, studio_spend, ledger_recent, and studio_agents for the roster.
2. Triage:
   - A blocked card: read its note. If the next step is clear and within the studio's scope, comment it and, if the card is too big, create a smaller one blocked on nothing. If it needs a human, say so in a comment and leave it.
   - A done card: its note is a report. Assign follow-up work only if that note or the operator asks for it.
   - Nothing in flight and no ready work: create at most one card for the agent best placed to move the studio forward, with a clear title and a brief that says what done looks like.
   - Assignees are agent names exactly as studio_agents lists them; give every card a key (assign-<agent>-<topic>) so a retry cannot double-assign.
3. Log every steering decision with log_decision (topic "studio.cycle", refs = the card ids).
Rules: a few tool calls, then stop. Never invent work nobody asked for. Never redo finished work.`;

/** True once the Greenlight Chair's pick is in the ledger (topic greenlight.pick). */
export function hasGreenlightPick(ledgerFile = LEDGER_FILE): boolean {
  return ledgerRead(ledgerFile).some((e) => e.kind === "decision" && e.topic === "greenlight.pick");
}
