import type { Brief, ContextSnapshot, Run, RunEvent, Task } from "@fabric/contracts";
import { eventLog, m, PREFERENCES, RESEARCH_CRITERIA, run as run135, runEvents as events135, seg, snapshots as snaps135, sortEvents, STAYED } from "./run";

/**
 * Work: tasks (board cards) and their loops, on the same mock clock as Weave (Fri Oct 2, 11:20 AM).
 * The 135M loop is the recorded one; the 360M and NAND loops are mock-only and stop at "now".
 */

// ---- n-gram fusion at 360M: running, two asks waiting on you ----
const R360 = "run-ngram360-1";
const brief360: Brief = {
  tokens: 1340,
  objective: "Repeat the 135M test one model size up: does the n-gram table still lower held-out perplexity at 360M?",
  constraints: [
    "Same held-out split as the 135M loop",
    "The table stays on disk",
    "Ask before any new download",
    "Measured results reported apart from speculation",
  ],
  criteria: RESEARCH_CRITERIA,
  preferences: PREFERENCES,
  stayed: STAYED,
};
const run360: Run = {
  id: R360,
  taskId: "ngram-360m",
  teamId: "research",
  n: 1,
  objective: "Does the n-gram table still help one model size up, at 360M?",
  status: "running",
  startedAt: "2026-10-02T09:05:00-07:00",
  recorded: false,
  durationS: m(135),
  etaS: m(335),
  costUsd: 0.34,
  budget: { costUsd: 1.5, timeS: m(360) },
  reworkBudget: 2,
  assistantTokens: 2140,
  brief: brief360,
  segments: [
    seg("elliot", "Plan", "Plan", 0, 12),
    seg("megan", "Prepare", "Survey", 12, 43),
    seg("jonah", "Prepare", "Setup", 12, 25),
    seg("sana", "Prepare", "Prep checks", 12, 125),
    seg("sana", "Prepare", "Blocked · C4 shard", 125, 135, "blocked"),
    seg("elliot", "Synthesize", "Synthesize", 43, 57),
    seg("elliot", "Implement", "Needs you · seeds", 111, 135, "wait"),
    seg("jonah", "Implement", "Implement", 57, 123),
    seg("jonah", "Implement", "Needs you · fetch", 123, 135, "wait"),
  ],
};
const e360 = eventLog(R360);
const events360: RunEvent[] = [
  e360.ev(0, "run.started", undefined, { objective: run360.objective }),
  ...e360.steps(run360.segments),
  e360.say(m(1), "elliot", "Plan: the same held-out split as the 135M loop, one model size up."),
  e360.artifact(m(12), "elliot", "plan.md"),
  e360.say(m(14), "megan", "exa.search “conditional memory below 1B parameters” · deep"),
  e360.say(m(31), "megan", "9 papers read, 3 cited. One preprint reports gains at ~350M."),
  e360.artifact(m(43), "megan", "survey.md"),
  e360.term(m(13), "jonah", "$ sprite exec uv sync --frozen"),
  e360.term(m(22), "jonah", "pinned env ready · torch 2.6 · transformers 4.51"),
  e360.say(m(15), "sana", "Reusing heldout-v1 from the 135M loop; checking it against the 360M tokenizer."),
  e360.say(m(30), "sana", "Cached the held-out split in my own sandbox."),
  e360.check(m(31), "sana", 1, true, "train_only/ corpus: 0% overlap with heldout-v1"),
  e360.say(m(50), "elliot", "Synthesis: same λ = 0.30; add a second held-out shard for a tighter estimate."),
  e360.ev(m(57), "handoff", "elliot", { to: "jonah", step: "Implement" }),
  e360.term(m(60), "jonah", "$ python build_ngram.py --n 4 --corpus data/train_only/"),
  e360.term(m(80), "jonah", "table built · 4-gram · 3.1 GB on disk"),
  e360.term(m(92), "jonah", "$ python eval.py --model 360m --split heldout"),
  e360.term(m(96), "jonah", "CUDA OOM at batch 8 · retrying with gradient checkpointing"),
  e360.term(m(104), "jonah", "baseline 360M: ppl 21.7"),
  e360.say(m(111), "elliot", "Asked Ty: two seeds like the paper, or three for a tighter interval?"),
  e360.ev(m(123), "tool.denied", "jonah", { tool: "network.fetch", target: "data.commoncrawl.org", reason: "not on the egress list" }),
  e360.say(m(123), "jonah", "Asked Ty to allow one fetch: the 2.1 GB C4 validation shard."),
  e360.say(m(125), "sana", "Waiting for Jonah's shard before building the second split."),
];

// ---- NAND latency probe: loop 1 stopped by you, loop 2 out of rework budget ----
const NAND_CRITERIA = [
  "Timing excludes warm-up and cache effects",
  "p50 and p99 reported for each page size",
  "Sana reproduces p50 within 10%",
  "Report states caveats and what would change the verdict",
];
const nandBrief = (tokens: number, extra: string[]): Brief => ({
  tokens,
  objective: "Measure p50 and p99 read latency for n-gram table lookups served from NAND, to see whether offloading is fast enough for interactive use.",
  constraints: ["Real drive reads, not simulated ones", "4 KB and 16 KB pages", "Ask before renting or buying hardware", ...extra],
  criteria: NAND_CRITERIA,
  preferences: PREFERENCES,
  stayed: STAYED,
});

const RN1 = "run-nand-1";
const nand1: Run = {
  id: RN1,
  taskId: "nand-probe",
  teamId: "research",
  n: 1,
  objective: "Is NAND fast enough to serve n-gram table lookups?",
  status: "stopped",
  startedAt: "2026-09-30T10:00:00-07:00",
  recorded: false,
  durationS: m(65),
  costUsd: 0.12,
  budget: { costUsd: 0.6, timeS: m(180) },
  reworkBudget: 2,
  assistantTokens: 2140,
  brief: nandBrief(1180, []),
  outcome: "You stopped it: the harness was timing the OS page cache, not the drive. Loop 2 re-plans with direct reads.",
  segments: [
    seg("elliot", "Plan", "Plan", 0, 8),
    seg("jonah", "Implement", "Implement", 8, 40),
    seg("sana", "Validate", "Validate", 40, 58),
    seg("elliot", "Validate", "Escalated", 58, 65, "wait"),
  ],
};
const en1 = eventLog(RN1);
const eventsN1: RunEvent[] = [
  en1.ev(0, "run.started", undefined, { objective: nand1.objective }),
  ...en1.steps(nand1.segments),
  en1.say(m(2), "elliot", "Plan: random reads over a 3 GB table file, 4 KB and 16 KB pages."),
  en1.term(m(10), "jonah", "$ python harness.py --table ngram4.bin --pages 4k,16k"),
  en1.term(m(36), "jonah", "p50 0.9 µs · p99 3.1 µs (4 KB)"),
  en1.artifact(m(40), "jonah", "harness.py"),
  en1.say(m(44), "sana", "These numbers are RAM speed. Checking where the reads land."),
  en1.check(m(55), "sana", 0, false, "Reads hit the OS page cache; nothing touched the drive"),
  en1.say(m(58), "elliot", "Escalated to Dana: the harness measures the cache, not NAND."),
  en1.ev(m(65), "run.stopped", undefined, { by: "you", text: nand1.outcome }),
];

const RN2 = "run-nand-2";
const nand2: Run = {
  id: RN2,
  taskId: "nand-probe",
  teamId: "research",
  n: 2,
  objective: "Is NAND fast enough to serve n-gram table lookups?",
  status: "blocked",
  startedAt: "2026-10-02T08:05:00-07:00",
  recorded: false,
  durationS: m(195),
  costUsd: 0.38,
  budget: { costUsd: 0.6, timeS: m(240) },
  reworkBudget: 2,
  assistantTokens: 2140,
  brief: nandBrief(1240, ["Direct reads only (O_DIRECT); drop the page cache before each pass"]),
  segments: [
    seg("elliot", "Plan", "Plan", 0, 10),
    seg("jonah", "Implement", "Implement", 10, 52),
    seg("sana", "Validate", "Validate", 52, 62),
    seg("carlos", "Review", "Bounced", 62, 67, "bounce"),
    seg("elliot", "Plan", "Re-plan", 67, 75),
    seg("jonah", "Implement", "Rework", 75, 120, "rework"),
    seg("sana", "Validate", "Re-check", 120, 148),
    seg("carlos", "Review", "Bounced", 148, 153, "bounce"),
    seg("elliot", "Review", "Escalated", 153, 155),
    seg("elliot", "Review", "Needs you · budget", 155, 195, "wait"),
  ],
};
const en2 = eventLog(RN2);
const eventsN2: RunEvent[] = [
  en2.ev(0, "run.started", undefined, { objective: nand2.objective }),
  ...en2.steps(nand2.segments),
  en2.say(m(2), "elliot", "Plan: direct reads with O_DIRECT, cache dropped before each pass."),
  en2.term(m(12), "jonah", "$ fio --direct=1 --rw=randread --bs=4k,16k --filename=ngram4.bin"),
  en2.term(m(48), "jonah", "p50 82 µs · p99 410 µs (4 KB) · p50 96 µs · p99 455 µs (16 KB)"),
  en2.artifact(m(52), "jonah", "harness.py"),
  en2.check(m(60), "sana", 1, true, "p50 and p99 for 4 KB and 16 KB"),
  en2.check(m(62), "carlos", 0, false, "Latency includes cache warm-up"),
  en2.ev(m(67), "review.verdict", "carlos", { verdict: "request_changes", text: "The latency numbers include cache warm-up. Back to Elliot to discard the warm-up reads." }),
  en2.ev(m(67), "rework.requested", "carlos", { to: "elliot", used: 1, budget: 2 }),
  en2.say(m(70), "elliot", "Re-plan: discard the first 1k reads of every pass."),
  en2.term(m(78), "jonah", "$ python harness.py --direct --discard-first 1000"),
  en2.term(m(115), "jonah", "p50 61 µs · p99 380 µs (4 KB)"),
  en2.check(m(145), "sana", 2, true, "p50 reproduced within 6%"),
  en2.check(m(150), "carlos", 0, false, "Warm-up still leaks into p50 on the 16 KB pass"),
  en2.ev(m(153), "review.verdict", "carlos", { verdict: "request_changes", text: "Warm-up still leaks into p50 on the 16 KB pass. That spends the second rework." }),
  en2.ev(m(153), "rework.requested", "carlos", { to: "elliot", used: 2, budget: 2 }),
  en2.say(m(154), "elliot", "Rework budget spent. Escalated to Dana; nothing more runs until Ty decides."),
  en2.ev(m(155), "run.blocked", "elliot", { reason: "Rework budget spent", itemId: "nand-budget" }),
];

// ---- snapshots for the mock-only loops ----
const sections = (soul: number, briefTokens: number, tools: number, prefs: number, refs: number, knowledge: number, prefCount: number) => [
  { label: "Soul / identity", source: "SOUL.md · IDENTITY.md", tokens: soul },
  { label: "Task brief", source: "compiled by Dana", tokens: briefTokens },
  { label: "Tools & policy", source: "Executor", tokens: tools },
  { label: "User preferences", source: `USER.md · ${prefCount} items`, tokens: prefs },
  { label: "Artifact references", source: "links, not content", tokens: refs },
  { label: "Team knowledge", source: "retrieved on demand", tokens: knowledge },
];
const withTotal = (s: Omit<ContextSnapshot, "totalTokens">): ContextSnapshot => ({ ...s, totalTokens: s.sections.reduce((n, x) => n + x.tokens, 0) });
const coderTools = [
  { name: "sprite.exec", policy: "allowed" as const },
  { name: "workspace.write", policy: "allowed" as const },
  { name: "artifacts.read", policy: "allowed" as const },
  { name: "network.fetch", policy: "blocked" as const },
];

const otherSnapshots: ContextSnapshot[] = [
  withTotal({
    id: "snap-360-jonah-setup", runId: R360, agentId: "jonah", step: "Setup", assembledAtS: m(12),
    sections: sections(812, 1340, 1860, 240, 1250, 1950, 2), tools: coderTools,
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Includes his own lesson from the 135M loop (--bf16 for the baseline).",
  }),
  withTotal({
    id: "snap-360-sana-prep", runId: R360, agentId: "sana", step: "Prep checks", assembledAtS: m(12),
    sections: sections(640, 1340, 1010, 0, 240, 800, 0),
    tools: [{ name: "artifacts.read", policy: "allowed" }, { name: "sprite.exec", policy: "allowed" }, { name: "workspace.write", policy: "blocked" }],
    notLoaded: "your chat transcript · personal memory · Elliot's plan rationale",
    note: "Reuses the 135M held-out split by reference, not by copy.",
  }),
  withTotal({
    id: "snap-360-jonah-implement", runId: R360, agentId: "jonah", step: "Implement", assembledAtS: m(57),
    sections: sections(812, 1340, 1860, 240, 520, 2100, 2), tools: coderTools,
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Soul, brief, tool policy, plan and survey refs.",
  }),
  withTotal({
    id: "snap-n1-jonah", runId: RN1, agentId: "jonah", step: "Implement", assembledAtS: m(8),
    sections: sections(812, 1180, 1860, 240, 0, 0, 2), tools: coderTools,
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Soul, brief, tool policy.",
  }),
  withTotal({
    id: "snap-n2-jonah", runId: RN2, agentId: "jonah", step: "Implement", assembledAtS: m(10),
    sections: sections(812, 1240, 1860, 240, 180, 640, 2), tools: coderTools,
    notLoaded: "your chat transcript · personal memory · other specialists' skills",
    note: "Includes loop 1's finding: drop the page cache before timing.",
  }),
  withTotal({
    id: "snap-n2-carlos", runId: RN2, agentId: "carlos", step: "Review", assembledAtS: m(148),
    sections: sections(760, 1240, 380, 0, 420, 600, 0),
    tools: [{ name: "artifacts.read", policy: "allowed" }, { name: "workspace.write", policy: "blocked" }],
    notLoaded: "your chat transcript · personal memory · Elliot's plan rationale",
    note: "Reads the evidence, not the reasoning that produced it.",
  }),
];

export const runs: Run[] = [run135, run360, nand1, nand2];
export const runEventsById: Record<string, RunEvent[]> = {
  [run135.id]: events135,
  [R360]: sortEvents(events360),
  [RN1]: sortEvents(eventsN1),
  [RN2]: sortEvents(eventsN2),
};
export const allSnapshots: ContextSnapshot[] = [...snaps135, ...otherSnapshots];

export const tasks: Task[] = [
  { id: "ngram-135m", projectId: "engram", teamId: "research", title: "n-gram fusion on a 135M model", runIds: [run135.id] },
  { id: "ngram-360m", projectId: "engram", teamId: "research", title: "n-gram fusion at 360M", runIds: [R360] },
  { id: "nand-probe", projectId: "engram", teamId: "research", title: "NAND latency probe", runIds: [RN1, RN2] },
  {
    id: "product-bet",
    projectId: "engram",
    teamId: "product",
    title: "Can these results drive a real product?",
    runIds: [],
    proposal: {
      itemId: "handoff-product",
      at: "2026-10-02T08:30:00-07:00",
      note: "Dana proposed handing the 135M results to the Product Team.",
      purpose: "Diego frames the bet, Lila looks for demand, and Maya sketches a first experience.",
    },
    // No Product Team loop is recorded, so nothing behind this card can play yet.
    preview: true,
  },
];
