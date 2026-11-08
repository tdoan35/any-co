// Live Work view: projects per game, and the studio board's cards as tasks.
// The adapter serves one task per run, all under one "studio" project, plus the board's cards
// (GET /api/board-cards) with the game each belongs to. This merges them on the client:
// - Projects: one per game (from runs and cards), plus "Studio" for studio-level work.
// - Tasks: each board card is a task whose loops are the runs that worked it. A run belongs to a card
//   when its objective starts with "# <card title>" (the dispatcher writes every card run that way).
//   Runs with no card (Studio Head cycles, pre-board Greenlight) stay one task each, filed by run.game.
// Pure and app-free (type imports only), so node's test runner can check it.
import type { Project, Run, Task } from "@fabric/contracts";

export type CardStatus = "todo" | "doing" | "blocked" | "done";
export interface BoardCardRow {
  id: string;
  title: string;
  status: CardStatus;
  assignee: string | null;
  game: string | null;
  created_at: string;
  updated_at: string;
  /** Card ids this card was created to wait on (when the adapter sends them). */
  upstream?: string[];
}

export const STUDIO_PROJECT_ID = "studio";

/** "caravan-cargo-cult" -> "Caravan Cargo Cult". */
export const gameName = (slug: string) => slug.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

export interface BoardView {
  projects: Project[];
  tasks: Task[];
  /** Card behind a task id (only card tasks). */
  cards: Map<string, BoardCardRow>;
  /** Adapter task id (one per run) -> the task that now holds that run. */
  taskOf: Map<string, string>;
}

/** The card title a run was started for, if its objective opens with "# <title>". */
export const cardTitleOf = (objective: string) => {
  const first = objective.split("\n", 1)[0]!.trim();
  return first.startsWith("# ") ? first.slice(2).trim() : undefined;
};

/** Of several cards with the run's title, the one made most recently before the run started, same game first. */
function pick(cards: BoardCardRow[], run: Run): BoardCardRow {
  const started = Date.parse(run.startedAt);
  const before = cards.filter((c) => Date.parse(c.created_at) <= started);
  const pool = before.length ? before : cards;
  const sameGame = pool.filter((c) => !run.game || !c.game || c.game === run.game);
  return [...(sameGame.length ? sameGame : pool)].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
}

export function buildBoardView(input: {
  tasks: Task[];
  runs: Run[];
  cards: BoardCardRow[];
  /** Team id for an agent with no run on its card yet (todo cards). */
  teamOfAgent: (agent: string) => string | undefined;
}): BoardView {
  const { tasks, runs, cards, teamOfAgent } = input;
  const byTitle = new Map<string, BoardCardRow[]>();
  for (const c of cards) {
    const k = c.title.trim();
    byTitle.set(k, [...(byTitle.get(k) ?? []), c]);
  }

  // Each run to its card, when it has one.
  const runsOfCard = new Map<string, Run[]>();
  const cardOfRun = new Map<string, string>();
  for (const run of runs) {
    const title = cardTitleOf(run.objective);
    const candidates = title ? byTitle.get(title) : undefined;
    if (!candidates?.length) continue;
    const card = pick(candidates, run);
    cardOfRun.set(run.id, card.id);
    runsOfCard.set(card.id, [...(runsOfCard.get(card.id) ?? []), run]);
  }

  const out: Task[] = [];
  const cardTasks = new Map<string, BoardCardRow>();
  const taskOf = new Map<string, string>();

  for (const card of cards) {
    const loops = (runsOfCard.get(card.id) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const latest = loops.at(-1);
    // The adapter's card game (games/<slug>, a slug mention, the import sidecars) is the word on it; a card it
    // leaves without a game is studio-level, even when its runs cloned a game repo to have a workspace.
    const game = card.game;
    out.push({
      id: card.id,
      projectId: game ?? STUDIO_PROJECT_ID,
      teamId: latest?.teamId ?? (card.assignee ? teamOfAgent(card.assignee) : undefined) ?? "team-head",
      title: card.title,
      runIds: loops.map((r) => r.id),
    });
    cardTasks.set(card.id, card);
    for (const r of loops) taskOf.set(r.taskId, card.id);
  }

  const runById = new Map(runs.map((r) => [r.id, r]));
  for (const t of tasks) {
    if (t.runIds.some((id) => cardOfRun.has(id))) continue; // folded into its card
    const game = t.runIds.map((id) => runById.get(id)?.game).find((g): g is string => !!g);
    out.push({ ...t, projectId: game ?? STUDIO_PROJECT_ID });
    taskOf.set(t.id, t.id);
  }

  // Projects: every game with work, newest activity first; Studio last.
  const lastAt = new Map<string, string>();
  for (const t of out) {
    const at = t.runIds.map((id) => runById.get(id)?.startedAt ?? "").sort().at(-1) ?? cardTasks.get(t.id)?.updated_at ?? "";
    if (at > (lastAt.get(t.projectId) ?? "")) lastAt.set(t.projectId, at);
  }
  const games = [...new Set(out.map((t) => t.projectId))].filter((p) => p !== STUDIO_PROJECT_ID)
    .sort((a, b) => (lastAt.get(b) ?? "").localeCompare(lastAt.get(a) ?? ""));
  const projects: Project[] = games.map((slug) => ({ id: slug, name: gameName(slug), goal: `Studio-made game · games/${slug}` }));
  if (out.some((t) => t.projectId === STUDIO_PROJECT_ID)) {
    projects.push({ id: STUDIO_PROJECT_ID, name: "Studio", goal: "Cards and runs that belong to no game" });
  }

  return { projects, tasks: out, cards: cardTasks, taskOf };
}
