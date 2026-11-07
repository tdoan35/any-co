import type { Brief, ContextSnapshot, Report, Run, RunEvent, RunSegment } from "@fabric/contracts";

/**
 * The one recorded real loop: n-gram fusion on a 135M model (Research Team, Sep 29).
 * The demo's live start plays it from 0 at 1× (`?live=1`); everything else replays it.
 */
export const m = (min: number) => min * 60;
const RUN_ID = "run-ngram-1";

export const seg = (agentId: string, stage: string, label: string, s: number, e: number, kind: RunSegment["kind"] = "work"): RunSegment => ({
  agentId, stage, label, start: m(s), end: m(e), kind,
});

/** Events for one loop, numbered in the order they're written. */
export function eventLog(runId: string) {
  let seq = 0;
  const ev = (t: number, type: RunEvent["type"], actorAgentId?: string, payload: RunEvent["payload"] = {}): RunEvent => ({
    runId, seq: ++seq, t, type, actorAgentId, payload,
  });
  return {
    ev,
    /** Narration: what an agent says it's doing. */
    say: (t: number, agent: string, text: string) => ev(t, "agent.message", agent, { text }),
    /** Sandbox terminal output. */
    term: (t: number, agent: string, line: string) => ev(t, "tool.result", agent, { line, kind: "term" }),
    check: (t: number, agent: string, index: number, pass: boolean, note: string) => ev(t, "criterion.checked", agent, { index, pass, note }),
    artifact: (t: number, agent: string, name: string) => ev(t, "artifact.created", agent, { name }),
    steps: (segments: RunSegment[]) => segments.flatMap((s) => [
      ev(s.start, "step.started", s.agentId, { label: s.label, stage: s.stage, kind: s.kind }),
      ev(s.end, "step.finished", s.agentId, { label: s.label, stage: s.stage, kind: s.kind }),
    ]),
  };
}

export const sortEvents = (events: RunEvent[]) => events.sort((a, b) => a.t - b.t || a.seq - b.seq);

/** What every specialist brief leaves behind with Dana. */
export const STAYED = ["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"];
/** From each specialist's USER.md ("Wants: short status updates, results with evidence"). */
export const PREFERENCES = ["Short status updates", "Results with evidence, not adjectives"];
export const RESEARCH_CRITERIA = [
  "Baseline and fused model evaluated on the same split",
  "Held-out split never seen by the n-gram table",
  "Sana reproduces the headline number",
  "Report states caveats and what would change the verdict",
];

const brief: Brief = {
  tokens: 1290,
  objective: "Test whether fusing an n-gram lookup table into a 135M open model lowers held-out perplexity, with the table kept on disk instead of in RAM.",
  constraints: [
    "Cached corpus only; no new downloads",
    "One base model and one interpolation weight to start",
    "The table stays on disk, never loaded into RAM",
    "Measured results reported apart from speculation",
  ],
  criteria: RESEARCH_CRITERIA,
  preferences: PREFERENCES,
  stayed: STAYED,
};

export const run: Run = {
  id: RUN_ID,
  taskId: "ngram-135m",
  teamId: "research",
  n: 1,
  objective: "Does an n-gram lookup table improve a much smaller open model?",
  status: "accepted",
  startedAt: "2026-09-29T13:04:00-07:00",
  recorded: true,
  durationS: m(192), // 3h 12m
  costUsd: 0.42,
  budget: { costUsd: 1, timeS: m(240) },
  reworkBudget: 2,
  assistantTokens: 2140,
  brief,
  outcome: "Carlos accepted it after one rework. The first attempt's gain came from split overlap and is left out of the report.",
  reportId: "report-ngram-1",
  segments: [
    seg("elliot", "Plan", "Plan", 0, 12),
    seg("megan", "Prepare", "Survey", 0.1, 55),
    seg("jonah", "Prepare", "Setup", 0.1, 58),
    seg("sana", "Prepare", "Prep checks", 0.1, 50),
    seg("elliot", "Synthesize", "Synthesize", 62, 76),
    seg("jonah", "Implement", "Implement", 76, 122),
    seg("sana", "Validate", "Validate", 122, 148),
    seg("carlos", "Review", "Bounced", 148, 158, "bounce"),
    seg("elliot", "Plan", "Re-plan", 158, 171),
    seg("jonah", "Implement", "Rework", 171, 183, "rework"),
    seg("sana", "Validate", "Re-check", 183, 188),
    seg("carlos", "Review", "Accepted", 188, 192),
  ],
};

const { ev, say, term, check, artifact, steps } = eventLog(RUN_ID);

const events: RunEvent[] = [
  ev(0, "run.started", undefined, { objective: run.objective }),
  ...steps(run.segments),

  // ---- live-start window (first ~45 s) ----
  say(2, "elliot", "Drafting the plan: survey, environment and held-out checks in parallel."),
  say(6, "megan", "exa.search “engram conditional memory n-gram lookup” · fast"),
  say(11, "megan", "8 results · 3 highlights kept (Engram, kNN-LM, n-gram LM fusion)"),
  say(19, "megan", "exa.search “offload embedding tables to NAND flash inference” · fast"),
  say(27, "megan", "6 results · 2 highlights kept"),
  term(8, "jonah", "$ sprite exec pip install torch transformers --quiet"),
  term(17, "jonah", "installed transformers 4.51 · torch 2.6"),
  term(24, "jonah", "$ python setup_baseline.py --model 135m"),
  term(33, "jonah", "loading base model · 135M params"),
  term(41, "jonah", "baseline harness ready"),
  say(12, "sana", "Drafting the held-out split spec, independent of Elliot's plan."),
  say(30, "sana", "Split fixed: 20% held out."),
  artifact(m(12), "elliot", "plan.md"),

  // ---- survey, synthesis ----
  say(m(40), "megan", "Read 9 papers; Engram reports gains only above 1B parameters."),
  artifact(m(55), "megan", "literature-survey.md"),
  say(m(63), "elliot", "Synthesis: test a 4-gram table at λ = 0.30 against the plain baseline."),
  ev(m(76), "handoff", "elliot", { to: "jonah", step: "Implement" }),

  // ---- implement (first attempt) ----
  term(m(77), "jonah", "$ python build_ngram.py --n 4 --corpus data/"),
  term(m(90), "jonah", "table built · 4-gram · stored on disk, not RAM"),
  term(m(100), "jonah", "$ python eval.py --split heldout"),
  term(m(108), "jonah", "evaluating baseline …"),
  term(m(115), "jonah", "evaluating fused (λ = 0.30) …"),
  term(m(118), "jonah", "fused: ppl 19.8 · baseline 34.2"),
  ev(m(121), "tool.denied", "jonah", { tool: "network.fetch", target: "files.example.org", reason: "not on the egress list" }),
  artifact(m(122), "jonah", "code-bundle.zip"),

  // ---- validate + reviewer bounce ----
  say(m(124), "sana", "Running held-out checks on attempt 1."),
  check(m(130), "sana", 0, true, "Both models scored on heldout-v1"),
  say(m(146), "sana", "Overlap: 41% of eval n-grams are in the table's corpus."),
  check(m(146), "sana", 1, false, "41% of eval n-grams appear in the table's corpus"),
  ev(m(155), "review.verdict", "carlos", {
    verdict: "request_changes",
    text: "The first attempt's results are contaminated: the n-gram table was built on text that overlaps the evaluation split. Back to Elliot to re-plan with a held-out corpus.",
  }),
  ev(m(155), "rework.requested", "carlos", { to: "elliot", used: 1, budget: 2 }),
  ev(m(155), "budget.update", undefined, { reworkUsed: 1, reworkBudget: 2 }),
  ev(m(158), "handoff", "carlos", { to: "elliot" }),

  // ---- rework ----
  say(m(160), "elliot", "Re-plan: rebuild the table from train_only/ and re-run both models."),
  term(m(172), "jonah", "$ python build_ngram.py --n 4 --corpus data/train_only/"),
  term(m(178), "jonah", "$ python eval.py --split heldout"),
  term(m(182), "jonah", "fused (λ = 0.30): ppl 30.9 · baseline 34.2"),
  say(m(184), "sana", "Re-checking attempt 2 in my own sandbox."),
  check(m(185), "sana", 1, true, "Rebuilt on train_only/: 0% overlap"),
  check(m(188), "sana", 2, true, "Reproduced 30.9 ± 0.2 independently"),
  artifact(m(188), "sana", "eval-log.jsonl"),
  ev(m(190), "review.verdict", "carlos", { verdict: "accept", text: "The corrected run is valid and Sana reproduced it. Accepted after one rework." }),
  check(m(191), "carlos", 3, true, "Caveats and the proxy's limits are stated"),
  ev(m(192), "run.finished", undefined, { reportId: "report-ngram-1" }),
];

export const runEvents: RunEvent[] = sortEvents(events);

const standardSections = (soul: number, tools: number, prefs: number, refs: number, knowledge: number, prefCount: number) => [
  { label: "Soul / identity", source: "SOUL.md · IDENTITY.md", tokens: soul },
  { label: "Task brief", source: "compiled by Dana", tokens: brief.tokens },
  { label: "Tools & policy", source: "Executor", tokens: tools },
  { label: "User preferences", source: `USER.md · ${prefCount} items`, tokens: prefs },
  { label: "Artifact references", source: "links, not content", tokens: refs },
  { label: "Team knowledge", source: "retrieved on demand", tokens: knowledge },
];
const total = (s: { tokens: number }[]) => s.reduce((n, x) => n + x.tokens, 0);
const snap = (s: Omit<ContextSnapshot, "totalTokens" | "runId">, runId = RUN_ID): ContextSnapshot => ({ ...s, runId, totalTokens: total(s.sections) });

export const snapshots: ContextSnapshot[] = [
  snap({
    id: "snap-elliot-plan", agentId: "elliot", step: "Plan", assembledAtS: 1,
    sections: standardSections(904, 640, 240, 0, 420, 2),
    tools: [
      { name: "artifacts.read", policy: "allowed" },
      { name: "workspace.write", policy: "allowed" },
      { name: "team.assign", policy: "allowed" },
      { name: "network.fetch", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · members' tool schemas",
    note: "Soul, brief and the team's workflow. Members' tools stay with them.",
  }),
  snap({
    id: "snap-megan-survey", agentId: "megan", step: "Survey", assembledAtS: 4,
    sections: standardSections(712, 520, 240, 0, 0, 2),
    tools: [
      { name: "exa.search", policy: "allowed" },
      { name: "artifacts.write", policy: "allowed" },
      { name: "sprite.exec", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · the code sandbox",
    note: "Soul, brief and search tools. No sandbox, no personal memory.",
  }),
  snap({
    id: "snap-jonah-setup", agentId: "jonah", step: "Setup", assembledAtS: 6,
    sections: standardSections(812, 1860, 240, 0, 0, 2),
    tools: [
      { name: "sprite.exec", policy: "allowed" },
      { name: "workspace.write", policy: "allowed" },
      { name: "artifacts.read", policy: "allowed" },
      { name: "agentmail.send", policy: "approval" },
      { name: "network.fetch", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Soul, task brief, tool policy. No chat transcript, no personal memory.",
  }),
  snap({
    id: "snap-sana-prep", agentId: "sana", step: "Prep checks", assembledAtS: 10,
    sections: standardSections(640, 1010, 0, 0, 0, 0),
    tools: [
      { name: "artifacts.read", policy: "allowed" },
      { name: "sprite.exec", policy: "allowed" },
      { name: "workspace.write", policy: "blocked" },
      { name: "agentmail.send", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · Elliot's plan rationale",
    note: "Restricted: cannot edit acceptance criteria.",
  }),
  snap({
    id: "snap-jonah-implement", agentId: "jonah", step: "Implement", assembledAtS: m(76),
    sections: standardSections(812, 1860, 240, 310, 1900, 2),
    tools: [
      { name: "sprite.exec", policy: "allowed" },
      { name: "workspace.write", policy: "allowed" },
      { name: "artifacts.read", policy: "allowed" },
      { name: "agentmail.send", policy: "approval" },
      { name: "network.fetch", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Soul, task brief, tool policy, 2 artifact refs. No chat transcript, no personal memory.",
  }),
  snap({
    id: "snap-sana-validate", agentId: "sana", step: "Validate", assembledAtS: m(122),
    sections: standardSections(640, 1210, 0, 240, 800, 0),
    tools: [
      { name: "artifacts.read", policy: "allowed" },
      { name: "sprite.exec", policy: "allowed" },
      { name: "workspace.write", policy: "blocked" },
      { name: "agentmail.send", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · Elliot's plan rationale",
    note: "Restricted: cannot edit acceptance criteria. Sees project facts, never yours.",
  }),
  snap({
    id: "snap-carlos-review", agentId: "carlos", step: "Review", assembledAtS: m(148),
    sections: standardSections(760, 380, 0, 520, 600, 0),
    tools: [
      { name: "artifacts.read", policy: "allowed" },
      { name: "workspace.write", policy: "blocked" },
    ],
    notLoaded: "your chat transcript · personal memory · Elliot's plan rationale",
    note: "Reads the evidence, not the reasoning that produced it, so the review stays independent.",
  }),
];

export const report: Report = {
  id: "report-ngram-1",
  runId: RUN_ID,
  title: "Does an n-gram lookup table improve a much smaller open model?",
  intro: "The Research Team produced this report. Findings separate what was measured from what is speculation.",
  summary:
    "Fusing an inference-time n-gram table with a 135M-parameter model lowers held-out perplexity. The first attempt looked far better, but its table overlapped the evaluation text; Carlos caught this and the corrected run shows a smaller, valid gain. This is a proxy for a trained-in Engram, not a test of one.",
  results: [
    { config: "Baseline · 135M model", ppl: 34.2, delta: "—", valid: true },
    { config: "Fused · attempt 1", ppl: 19.8, delta: "−42%", valid: false },
    { config: "Fused · attempt 2 (held-out split)", ppl: 30.9, delta: "−9.6%", valid: true },
  ],
  caveats: [
    "Inference-time fusion is a proxy; a trained-in Engram may behave differently.",
    "One base model, one corpus, one interpolation weight.",
    "Speculation: NAND-offloaded tables would keep this gain at consumer-hardware latency. Not measured.",
  ],
  provenance: [
    { label: "Loop", value: "Loop 1 · recorded" },
    { label: "Reviewer verdict", value: "Accepted after 1 rework" },
    { label: "Rework used", value: "1 / 2" },
    { label: "Dana's context", value: "2.1k tokens" },
  ],
  madeBy: ["elliot", "megan", "jonah", "sana", "carlos"],
  artifacts: [
    { name: "code-bundle.zip", from: "Jonah · Sprite" },
    { name: "literature-survey.md", from: "Megan" },
    { name: "eval-log.jsonl", from: "Sana" },
  ],
  emailed: true,
};
