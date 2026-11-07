import type { CalendarEvent, InboxItem, Presence, PulseEntry } from "@fabric/contracts";
export type {
  ApprovalItem, CalendarEvent, EscalationItem, EventEntry, FindingItem, Health, InboxItem, ItemAction, ItemKind,
  MemoryEntry, PolicyEntry, Presence, PresenceState, ProposalItem, PulseEntry, QuestionItem, ResultItem, UpdateEntry,
} from "@fabric/contracts";

/**
 * Weave: where your organization reports to you. Inbox asks (left), Pulse updates (center), presence and your day (right).
 * The page runs on a fixed mock clock so it renders the same on every visit.
 * Each item names the Work task it's about (`taskId`), so its card can flag it and react to your decision.
 */
export const WEAVE_NOW = new Date("2026-10-02T11:20:00-07:00");
export const WEAVE_TZ = "America/Los_Angeles";

const t = (hhmm: string, day = "2026-10-02") => `${day}T${hhmm}:00-07:00`;
const RUN_360 = { label: "n-gram fusion at 360M", href: "/work/ngram-360m" };
const RUN_135 = { label: "n-gram fusion on a 135M model", href: "/work/ngram-135m" };
const PROJECT = "Engram on small models";

export const inboxSeed: InboxItem[] = [
  {
    id: "fetch-shard",
    kind: "approval",
    agentId: "jonah",
    project: PROJECT,
    taskId: "ngram-360m",
    run: RUN_360,
    title: "Fetch the C4 validation shard from data.commoncrawl.org",
    brief: "Jonah's data fetch",
    at: t("11:08"),
    unread: true,
    blocking: { step: "Implement", agentId: "jonah", since: t("11:08") },
    tool: "network.fetch",
    policy: "blocked",
    policyNote: "Only the package index and model host",
    preview: [
      { label: "URL", value: "data.commoncrawl.org/…/c4-validation-00003.json.gz" },
      { label: "Size", value: "2.1 GB · read-only download into the Sprite" },
      { label: "Egress", value: "Not on Jonah's allowlist" },
      { label: "Why", value: "The 360M eval needs a second held-out shard; the cached corpus has only one" },
    ],
    why: "Jonah's network.fetch is limited to the package index and model host. Reaching any other domain needs an exception from you.",
    actions: [
      {
        id: "once", label: "Allow once", variant: "primary",
        effect: {
          outcome: "Allowed once",
          event: "allowed Jonah one fetch from data.commoncrawl.org.",
          presence: [
            { agentId: "jonah", state: "working", activity: "Implement · downloading the C4 shard" },
            { agentId: "sana", state: "working", activity: "Prep checks · building the second split" },
          ],
        },
      },
      {
        id: "run", label: "Allow for this run", variant: "outline",
        effect: {
          outcome: "Allowed for this run",
          event: "allowed Jonah to fetch from data.commoncrawl.org for the 360M run.",
          policy: "Jonah can fetch from data.commoncrawl.org until the 360M run ends. His allowlist is unchanged after that.",
          presence: [
            { agentId: "jonah", state: "working", activity: "Implement · downloading the C4 shard" },
            { agentId: "sana", state: "working", activity: "Prep checks · building the second split" },
          ],
        },
      },
      {
        id: "deny", label: "Deny", variant: "ghost",
        effect: {
          outcome: "Denied",
          event: "denied Jonah's fetch. Elliot will re-plan around the cached corpus.",
          presence: [{ agentId: "jonah", state: "blocked", activity: "Implement · waiting for Elliot's re-plan" }],
        },
      },
    ],
  },
  {
    id: "seed-count",
    kind: "question",
    agentId: "elliot",
    project: PROJECT,
    taskId: "ngram-360m",
    run: RUN_360,
    title: "Two seeds like the paper, or three for a tighter interval?",
    brief: "Elliot's seed question",
    at: t("10:56"),
    unread: true,
    blocking: { step: "the long run", agentId: "elliot", since: t("10:56") },
    question: "Before Jonah starts the long run: match the paper's two seeds, or run three? Three gives Carlos a tighter interval to judge, but costs time.",
    context: [
      "The 135M result (−9.6% perplexity) was measured on two seeds.",
      "Carlos's review criteria ask for an interval, not just a point estimate.",
      "Sana's checks reuse whatever seed count you pick.",
    ],
    why: "Seed count changes the run's cost and the evidence Carlos will judge. Leads ask you when a choice moves the budget.",
    actions: [
      {
        id: "three", label: "Run three seeds", detail: "~25 min longer · +$0.06 · ETA ~3:05 PM", variant: "primary",
        effect: {
          outcome: "Three seeds",
          event: "chose three seeds for the 360M run. The ETA moves to ~3:05 PM.",
          presence: [{ agentId: "elliot", state: "working", activity: "Plan · updating the brief" }],
        },
      },
      {
        id: "two", label: "Match the paper: two", detail: "ETA ~2:40 PM · Carlos may ask for a caveat", variant: "outline",
        effect: {
          outcome: "Two seeds",
          event: "chose two seeds for the 360M run, matching the paper.",
          presence: [{ agentId: "elliot", state: "working", activity: "Plan · updating the brief" }],
        },
      },
      { id: "chat", label: "Discuss in chat", variant: "ghost", href: "/" },
    ],
  },
  {
    id: "nand-budget",
    kind: "escalation",
    agentId: "dana",
    project: PROJECT,
    taskId: "nand-probe",
    run: { label: "NAND latency probe · loop 2", href: "/work/nand-probe" },
    title: "The NAND latency probe is out of rework budget",
    brief: "the NAND probe's budget",
    at: t("10:44"),
    unread: true,
    blocking: { step: "the NAND probe", agentId: "elliot", since: t("10:40") },
    body: "Elliot escalated this to me. Carlos bounced the probe twice because the timing harness still counts warm-up reads, so both rework attempts are spent. Nothing more runs until you decide.",
    budget: { used: 2, total: 2 },
    history: [
      { agentId: "carlos", text: "Request changes: latency includes cache warm-up", at: t("09:12") },
      { agentId: "elliot", text: "Re-planned: discard the first 1k reads", at: t("09:20") },
      { agentId: "carlos", text: "Request changes: warm-up still leaks into p50", at: t("10:38") },
      { agentId: "elliot", text: "Escalated to Dana: rework budget spent", at: t("10:40") },
    ],
    why: "Runs stop when their rework budget runs out. The escalation goes member → lead → Dana → you.",
    actions: [
      {
        id: "raise", label: "Raise budget to 3", detail: "One more attempt · ~40 min · ~$0.20", variant: "primary",
        effect: { outcome: "Budget raised to 3", event: "raised the NAND probe's rework budget to 3. Elliot is re-planning the harness." },
      },
      {
        id: "caveat", label: "Accept with a caveat", detail: "The report ships marked “timing not validated”", variant: "outline",
        effect: { outcome: "Accepted with caveat", event: "accepted the NAND probe with the caveat “timing not validated”." },
      },
      {
        id: "stop", label: "Stop the run", detail: "Artifacts are kept; nothing else changes", variant: "outline",
        effect: { outcome: "Stopped", event: "stopped the NAND latency probe. Its artifacts are kept." },
      },
    ],
  },
  {
    id: "email-priya",
    kind: "approval",
    agentId: "sana",
    project: PROJECT,
    taskId: "ngram-135m",
    run: RUN_135,
    title: "Email the 135M validation summary to Priya Raman",
    brief: "Sana's email to Priya",
    at: t("09:52"),
    tool: "agentmail.send",
    policy: "approval",
    policyNote: "Emails the final report",
    gated: "Sending outside Fabric always asks, so there's no “always allow” here. Spending, merging and credentials work the same way.",
    preview: [
      { label: "From", value: "sana@fabric.mail" },
      { label: "To", value: "priya.raman@hey.com · external" },
      { label: "Cc", value: "you" },
      { label: "Subject", value: "n-gram fusion at 135M: validated numbers" },
    ],
    excerpt: "Hi Priya, Ty asked me to share the validated results. On a held-out split the fused 135M model reaches 30.9 perplexity against a 34.2 baseline (−9.6%), reproduced independently. The report and code bundle are attached.",
    why: "You asked on Tuesday to share the validated numbers with Priya. Sana's agentmail.send needs approval, and Priya is outside Fabric.",
    snoozeEvents: ["When Sana finishes her prep checks"],
    actions: [
      {
        id: "send", label: "Approve and send", variant: "primary",
        effect: { outcome: "Sent", event: "approved Sana's email. The 135M summary went to Priya Raman." },
      },
      { id: "deny", label: "Don't send", variant: "ghost", effect: { outcome: "Not sent", event: "declined Sana's email to Priya." } },
    ],
  },
  {
    id: "handoff-product",
    kind: "proposal",
    agentId: "dana",
    project: PROJECT,
    taskId: "product-bet",
    title: "Hand the 135M results to the Product Team?",
    brief: "my Product Team proposal",
    at: t("08:30"),
    unread: true,
    purpose: "“Can these results drive a real, value-driven product?” Diego would frame the bet, Lila would look for demand, and Maya would sketch a first experience.",
    roster: [
      { agentId: "diego", status: "lead" },
      { agentId: "lila", status: "existing" },
      { agentId: "jonah", status: "existing" },
      { agentId: "maya", status: "existing" },
    ],
    crosses: "The 135M report and this question",
    stays: "Your chat history and my memory of you",
    why: "The 135M run was accepted, and you route product questions to the Product Team. I propose; nothing starts until you say yes.",
    snoozeEvents: ["When the 360M run finishes"],
    actions: [
      {
        id: "go", label: "Hand off", variant: "primary",
        effect: {
          outcome: "Handed off",
          event: "handed the 135M results to the Product Team. Diego is framing the bet.",
          presence: [{ agentId: "diego", state: "working", activity: "Frame · reading the 135M report" }],
        },
      },
      { id: "later", label: "Not yet", variant: "outline", effect: { outcome: "Not yet", quiet: true, event: "passed on the Product Team handoff for now." } },
      { id: "chat", label: "Chat about this", variant: "ghost", href: "/" },
    ],
  },
  {
    id: "paper-350m",
    kind: "finding",
    agentId: "megan",
    project: PROJECT,
    taskId: "ngram-360m",
    run: RUN_360,
    title: "A new preprint reports Engram-style gains at ~350M",
    brief: "Megan's paper",
    at: t("09:40"),
    unread: true,
    source: { title: "Small Models, Big Tables: Conditional Memory Below 1B", venue: "arXiv preprint · Sep 30, 2026", url: "arxiv.org/abs/2609.18842" },
    relevance: "It measures a lookup-table gain on a 350M model, almost exactly the size of today's run. If it holds up, it's a baseline you'll want to compare against.",
    challenges: { owner: "Megan's memory", text: "Engram (2025) reports gains only above 1B params." },
    why: "Megan flags sources that change an assumption your current run depends on. Everything else she saves quietly to the project.",
    snoozeEvents: ["When the 360M run finishes"],
    actions: [
      {
        id: "send", label: "Send to Elliot", variant: "primary",
        effect: { outcome: "Sent to Elliot", event: "sent Megan's preprint to Elliot to weigh against the 360M plan." },
      },
      {
        id: "attach", label: "Attach to project", variant: "outline",
        effect: { outcome: "Attached", event: "attached Megan's preprint to Engram on small models." },
      },
      {
        id: "dismiss", label: "Dismiss", variant: "ghost",
        effect: { outcome: "Dismissed", quiet: true, event: "dismissed Megan's preprint. She'll weigh similar sources lower." },
      },
    ],
  },
  {
    id: "report-135m",
    kind: "result",
    agentId: "dana",
    project: PROJECT,
    taskId: "ngram-135m",
    run: RUN_135,
    title: "Results are ready: n-gram fusion on a 135M model",
    brief: "the 135M report",
    at: "2026-09-29T16:20:00-07:00",
    unread: true,
    reportId: "report-ngram-1",
    why: "You asked to hear when the experiment finished. Carlos accepted it after one rework.",
    actions: [
      { id: "open", label: "Open report", variant: "primary", href: "/reports/report-ngram-1" },
      { id: "run", label: "View loop", variant: "outline", href: "/work/ngram-135m" },
    ],
  },
  {
    id: "nand-datasets",
    kind: "finding",
    agentId: "megan",
    project: PROJECT,
    taskId: "nand-probe",
    title: "Two public NAND read-latency datasets were published",
    brief: "Megan's NAND datasets",
    at: t("08:05"),
    snoozedUntil: "Until Monday 9:00 AM",
    source: { title: "OpenFlash-Lat: per-page read latency traces", venue: "Dataset · Oct 1, 2026", url: "huggingface.co/datasets/openflash/lat" },
    relevance: "Real traces could replace the synthetic timings in the NAND probe's harness.",
    why: "It relates to the NAND probe, which is currently stopped on its rework budget.",
    actions: [
      { id: "attach", label: "Attach to project", variant: "primary", effect: { outcome: "Attached", event: "attached the NAND latency datasets to Engram on small models." } },
      { id: "dismiss", label: "Dismiss", variant: "ghost", effect: { outcome: "Dismissed", quiet: true, event: "dismissed the NAND datasets." } },
    ],
  },
];

export const pulseSeed: PulseEntry[] = [
  {
    id: "u-360",
    kind: "update",
    authorId: "elliot",
    project: PROJECT,
    title: "n-gram fusion at 360M",
    health: "on_track",
    at: t("10:05"),
    body: "Megan's survey is in and the plan is set: the same held-out split as the 135M run, one model size up. Jonah has started Implement, and Sana is preparing her checks in parallel.",
    diff: [
      { label: "Stage", from: "Prepare", to: "Implement" },
      { label: "Cost", from: "$0.11", to: "$0.27" },
      { label: "ETA", from: "—", to: "~2:40 PM" },
    ],
    links: [{ label: "View loop", href: "/work/ngram-360m" }, { label: "plan.md", artifact: true }, { label: "survey.md", artifact: true }],
  },
  {
    id: "u-nand",
    kind: "update",
    authorId: "elliot",
    project: PROJECT,
    title: "NAND latency probe",
    health: "at_risk",
    at: t("10:40"),
    body: "Carlos bounced the probe a second time: the timing harness still counts warm-up reads. That spends the whole rework budget, so I've escalated to Dana.",
    diff: [
      { label: "Rework", from: "1 / 2", to: "2 / 2" },
      { label: "Status", from: "Review", to: "Blocked" },
    ],
    links: [{ label: "View escalation", itemId: "nand-budget" }, { label: "harness.py", artifact: true }],
  },
  { id: "m-ckpt", kind: "memory", agentId: "jonah", at: t("10:41"), text: "The 360M model needs gradient checkpointing on a Sprite, or it runs out of memory.", source: "Implement · 360M run" },
  { id: "e-handoff", kind: "event", actorId: "elliot", at: t("10:02"), text: "handed Implement to Jonah." },
  { id: "e-survey", kind: "event", actorId: "megan", at: t("09:48"), text: "finished the survey: 9 papers read, 3 cited.", artifact: "survey.md" },
  { id: "q-cache", kind: "event", actorId: "sana", at: t("09:35"), text: "cached the held-out split in her own sandbox.", quiet: true },
  { id: "q-env", kind: "event", actorId: "jonah", at: t("09:30"), text: "set up a pinned Python environment in the Sprite.", quiet: true },
  { id: "q-snap", kind: "event", actorId: "jonah", at: t("09:17"), text: "recorded a context snapshot for Setup (6.4k tokens).", quiet: true },
  { id: "e-start", kind: "event", actorId: "dana", at: t("09:05"), text: "handed the 360M run to the Research Team with a compiled brief." },
  {
    id: "u-135",
    kind: "update",
    authorId: "carlos",
    project: PROJECT,
    title: "n-gram fusion on a 135M model",
    health: "done",
    at: "2026-09-29T16:16:00-07:00",
    body: "Accepted. The corrected run holds on the held-out split, and Sana reproduced it independently. The first attempt's gain came from split overlap and is excluded from the report.",
    diff: [
      { label: "Verdict", from: "Request changes", to: "Accept" },
      { label: "Rework", from: "0 / 2", to: "1 / 2" },
      { label: "Perplexity", from: "34.2", to: "30.9" },
    ],
    links: [{ label: "Open report", href: "/reports/report-ngram-1" }, { label: "View loop", href: "/work/ngram-135m" }],
  },
  { id: "e-sana", kind: "event", actorId: "dana", at: "2026-09-29T13:02:00-07:00", text: "added Sana · Validator to the Research Team after you approved her in chat." },
];

export const presenceSeed: Presence[] = [
  { agentId: "elliot", state: "waiting", activity: "Plan · seed count for the long run", since: t("10:56"), itemId: "seed-count" },
  { agentId: "jonah", state: "waiting", activity: "Implement · needs a data fetch", since: t("11:08"), itemId: "fetch-shard" },
  { agentId: "sana", state: "blocked", activity: "Prep checks · waiting for the C4 shard", since: t("11:10") },
  { agentId: "megan", state: "idle", activity: "Survey done", since: t("09:48") },
  { agentId: "carlos", state: "idle", activity: "Review starts after Validate", since: t("10:38") },
  { agentId: "diego", state: "idle", activity: "Product Team · no active run", since: t("08:00") },
  { agentId: "lila", state: "idle", activity: "Product Team · no active run", since: t("08:00") },
  { agentId: "maya", state: "idle", activity: "Product Team · no active run", since: t("08:00") },
];

/** Your calendar, read through Dana's calendar connector. Nothing before 10 AM (Dana's USER.md). */
export const calendarEvents: CalendarEvent[] = [
  { id: "c1", title: "Neon gateway spike review", start: t("10:30"), end: t("11:00"), kind: "meeting" },
  { id: "c2", title: "Lunch", start: t("12:00"), end: t("12:45"), kind: "personal" },
  { id: "c3", title: "Focus: demo rehearsal", start: t("13:00"), end: t("15:00"), kind: "focus" },
  { id: "c4", title: "Sponsor check-in", start: t("16:00"), end: t("16:30"), kind: "meeting" },
  { id: "c5", title: "Run the full dry-run ×3", start: t("10:00", "2026-10-03"), end: t("12:00", "2026-10-03"), kind: "focus" },
  { id: "c6", title: "Feature freeze", start: t("18:00", "2026-10-03"), end: t("18:30", "2026-10-03"), kind: "focus" },
  { id: "c7", title: "Hackathon setup", start: t("09:00", "2026-10-04"), end: t("10:30", "2026-10-04"), kind: "meeting" },
  { id: "c8", title: "Hacking", start: t("10:30", "2026-10-04"), end: t("16:30", "2026-10-04"), kind: "focus" },
  { id: "c9", title: "Review the 135M results", start: t("16:30", "2026-09-29"), end: t("17:00", "2026-09-29"), kind: "focus" },
];

/** Dots on the mini calendar. */
export const dayMarkers: { day: string; label: string; kind: "deadline" | "activity" }[] = [
  { day: "2026-09-29", label: "135M run accepted", kind: "activity" },
  { day: "2026-10-02", label: "360M run in progress", kind: "activity" },
  { day: "2026-10-04", label: "Hackathon demo", kind: "deadline" },
];
