// The Studio Head's cycle turn (T10): the fixed, mechanical task the studio loop gives it on its
// cadence, and the auto-start trigger. Mechanism only: no game, genre, or design content here.
import { read as ledgerRead, LEDGER_FILE } from "../tools/ledger/ledger.ts";

// The pipeline and milestones below are process, copied from docs/plan.md §6–7 (who hands what to whom, and when);
// the head reads the actual state from its tools. Nov 7: the first version only reacted to cards ("never invent work
// nobody asked for") and left every department idle while two art runs were in flight; this one drives the plan.
const PIPELINE = `Pipeline (docs/plan.md): each stage starts when its input exists, and stages run in parallel.
- design (game-design-director, level-content-designer): design doc, content data. The pitch-writer's three pitches are already done by the time the Chair has picked.
- engineering (tech-lead merges agent branches into the game's main and keeps the build green; gameplay-engineer-a and gameplay-engineer-b build features from the tech lead's tickets, one ticket each, never the same scenes).
- art (art-director: anchors, gate verdicts, fallback ladder; sprite-artist + sprite-artist-b, env-ui-artist + env-ui-artist-b: batch assets from the anchors; split a batch across A and B by asset id, never the same ids on both). Artists share one generation budget: at most one card per artist at a time.
- integration: when an agent branch (art, content, gameplay) has finished work, the tech-lead merges it into main and wires it into the build.
- QA, the release gate (qa-lead: contract smoke, determinism and invariants on the main build; playtester: an exploratory play report). This runs again after every merge batch, and its findings become engineering cards.
- balance and content breadth: gameplay-engineer-a, gameplay-engineer-b, or level-content-designer, working against the design doc's targets and QA's numbers.
- release (build-release): web build to the studio site, itch page and build, later the Windows build and the Steam page. Pushes and deploys are approval-gated, and a human decides them.
- marketing (marketing-lead, community-outreach): positioning, devlog, store copy, posts and outreach drafts. Sends are approval-gated.
- compliance (finance-compliance): signs off on every external page and post. Trailer and media come from autoplay captures.
- studio-historian: the devlog of decisions.`;

const MILESTONES = `Milestones (Pacific time): Sat 7:00 PM playable vertical slice; Sat 12:00 AM first public build (site + itch; human go/no-go ~11:30 PM);
Sun 7:00 AM feature freeze, polish and bug-fix only (human morning review); Sun 7:00–9:30 AM trailer, Steam page submitted, Windows build, marketing push;
Sun 9:30–10:30 AM release candidate passes the QA gate, final itch and site build; Sun 11:00 AM freeze.`;

export function headTask(now = new Date()): string {
  const pt = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
  return `Studio cycle. It is now ${pt} Pacific. Work from your tools only, in this order:
1. Look: board_list (board_get on every doing and blocked card), studio_runs (read the outputs of runs finished since your last cycle), studio_spend, ledger_recent, and studio_agents for the roster.
2. Triage:
   - A blocked card: read its note. If the next step is clear and within the studio's scope, comment it and, if the card is too big, create a smaller one blocked on nothing. If it needs a human, say so in a comment and leave it.
   - Replacing a blocked card (or one that ran out of turns) with a new card: pass supersedes: "<old card id>" to board_create, so the cards waiting on the old one wait on the new one and the old card closes.
   - A done card: its note is a report. Create the follow-up it calls for, and the next pipeline stage it unblocks (finished art or content → a tech-lead integration card; a merge → a QA card).
3. Drive the plan. Compare the pipeline and milestones below with what is done (the run outputs, done cards, the ledger). For every stage whose input exists, that is not done, and that has no todo or doing card, create ONE card for its agent. Aim at the next milestone first. Keep every department with ready work busy: the dispatcher starts cards as agents free up, so queueing ready work is right; use blocked_by for order.
   - A card says what done looks like and where the inputs are (branches, run ids, card ids). It never contains game content: the agents decide the content.
   - Assignees are agent names exactly as studio_agents lists them. Give every card a key (assign-<agent>-<topic>) so a retry cannot double-assign. Never assign studio-head.
   - Close to a milestone that is at risk, cut scope rather than slip it: a card that names the cut, logged.
4. Log every steering decision with log_decision (topic "studio.cycle", refs = the card ids), including why you created no card for a ready stage.
Rules: never redo finished work; never create a second card for work that already has one; spend caps and approvals are enforced for you.

${PIPELINE}

${MILESTONES}`;
}

/** Back-compat: the task as of module load (tests, docs). The loop calls headTask() per turn. */
export const HEAD_TASK = headTask();

/** True once the Greenlight Chair's pick is in the ledger (topic greenlight.pick). */
export function hasGreenlightPick(ledgerFile = LEDGER_FILE): boolean {
  return ledgerRead(ledgerFile).some((e) => e.kind === "decision" && e.topic === "greenlight.pick");
}
