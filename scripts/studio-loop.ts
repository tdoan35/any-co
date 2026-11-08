// The studio loop (T4/T10): poll the board, run local agents on due cards, close the cards,
// and (optionally) run the Studio Head on a cadence so the studio triages itself overnight.
//   npm run studio -- [--max-parallel 2] [--poll-s 10] [--once]
//                     [--approval-timeout-min 30] [--head-every-min 120]
// Board backend: STUDIO_BOARD=local (default; runs/board.jsonl, override with STUDIO_BOARD_FILE)
// or STUDIO_BOARD=naive (needs NAIVE_API_KEY and STUDIO_BOARD_REF, the Studio Head's brd_/agt_ id).
// Approvals: dispatched runs wait on the durable queue (`npm run approvals`), expiring after
// --approval-timeout-min. --approve-all is for tests only and ledgers as auto (T1).
// `touch runs/KILL` stops dispatch between passes and kills in-flight runs at their next call.
import { parseArgs } from "node:util";
import { loadAgent, loadAllAgents } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { boardFromEnv } from "../runner/board/index.ts";
import { studioLoop } from "../runner/dispatch.ts";
import { decide, queueApprover, request } from "../tools/approvals/approvals.ts";
import { read as ledgerRead } from "../tools/ledger/ledger.ts";
import type { Approver } from "../runner/run.ts";

const { values } = parseArgs({
  options: {
    "max-parallel": { type: "string", default: "2" },
    "poll-s": { type: "string", default: "10" },
    once: { type: "boolean", default: false },
    "approve-all": { type: "boolean", default: false },
    "approval-timeout-min": { type: "string", default: "30" },
    "head-every-min": { type: "string" },
  },
});

const approvalTimeoutMin = Number(values["approval-timeout-min"]);
if (!Number.isFinite(approvalTimeoutMin) || approvalTimeoutMin <= 0) {
  console.error("--approval-timeout-min must be a positive number of minutes");
  process.exit(2);
}
const headEveryMin = values["head-every-min"] !== undefined ? Number(values["head-every-min"]) : undefined;
if (headEveryMin !== undefined && (!Number.isFinite(headEveryMin) || headEveryMin <= 0)) {
  console.error("--head-every-min must be a positive number of minutes");
  process.exit(2);
}

// The Studio Head's cycle task. Fixed and mechanical — mechanism only, no game/genre/design
// content: look at the studio's own state, triage, assign next work, log the decisions.
const HEAD_TASK = `Studio cycle. Work from your tools only, in this order:
1. Look: board_list (board_get on every doing and blocked card), studio_runs, studio_spend, ledger_recent.
2. Triage:
   - A blocked card: read its note. If the next step is clear and within the studio's scope, comment it and, if the card is too big, create a smaller one blocked on nothing. If it needs a human, say so in a comment and leave it.
   - A done card: its note is a report. Assign follow-up work only if that note or the operator asks for it.
   - Nothing in flight and no ready work: create at most one card for the agent best placed to move the studio forward, with a clear title and a brief that says what done looks like.
3. Log every steering decision with log_decision (topic "studio.cycle", refs = the card ids).
Rules: a few tool calls, then stop. Never invent work nobody asked for. Never redo finished work.`;

const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
const board = boardFromEnv(naive);
const { ok, errors } = await loadAllAgents();
for (const e of errors) console.warn(`skipping agents/${e.agent}: ${e.message}`);
const specs = new Map(ok.filter((s) => s.runner === "local").map((s) => [s.name, s]));
if (!specs.size) throw new Error("no local agent specs found under agents/");

// Approval gate for dispatched runs (rule 4): the durable queue by default (the operator decides
// from `npm run approvals`; unanswered requests expire after --approval-timeout-min), --approve-all
// decides immediately as auto for tests. Both paths ledger the decision.
const approver: Approver = values["approve-all"]
  ? async (req) => (decide(request(req), true, "auto (--approve-all)"), true)
  : queueApprover({ timeoutMs: approvalTimeoutMin * 60_000 });

const head = headEveryMin !== undefined ? await loadAgent("studio-head") : undefined;

console.log(
  `studio loop: ${specs.size} local agent(s), board ${process.env.STUDIO_BOARD ?? "local"}` +
    (headEveryMin !== undefined ? `, studio-head every ${headEveryMin}min` : "") +
    (values.once ? ", one pass" : `, polling every ${values["poll-s"]}s`),
);

await studioLoop({
  board,
  specs,
  provider: (spec) => providerFor(spec, naive),
  naive,
  approver,
  maxParallel: Number(values["max-parallel"]),
  pollS: Number(values["poll-s"]),
  once: values.once,
  ...(head && headEveryMin !== undefined
    ? {
        headEveryMin,
        head: { spec: head, task: HEAD_TASK, provider: (spec: typeof head) => providerFor(spec, naive) },
        hasGreenlightPick: () => ledgerRead().some((e) => e.kind === "decision" && e.topic === "greenlight.pick"),
      }
    : {}),
  log: (l) => console.log(l),
});
