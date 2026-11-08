// The studio loop (T4/T10): poll the board, run local agents on due cards, close the cards,
// and (optionally) run the Studio Head on a cadence so the studio triages itself overnight.
//   npm run studio -- [--max-parallel 2] [--poll-s 10] [--once]
//                     [--approval-timeout-min 30] [--head-every-min 120 [--head-now]]
// --head-now runs one Studio Head turn at startup (restart, dry run); without it the first turn
// comes after one cadence, or at once when the board is empty and a Greenlight pick is ledgered.
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
import { buildApprover } from "./approver.ts";
import { HEAD_TASK, hasGreenlightPick } from "../runner/head-cycle.ts";
import type { Approver } from "../runner/run.ts";

const { values } = parseArgs({
  options: {
    "max-parallel": { type: "string", default: "2" },
    "poll-s": { type: "string", default: "10" },
    once: { type: "boolean", default: false },
    "approve-all": { type: "boolean", default: false },
    "approval-timeout-min": { type: "string", default: "30" },
    "head-every-min": { type: "string" },
    "head-now": { type: "boolean", default: false },
  },
});

const approvalTimeoutMin = Number(values["approval-timeout-min"]);
if (!Number.isFinite(approvalTimeoutMin) || approvalTimeoutMin <= 0) {
  console.error("--approval-timeout-min must be a positive number of minutes");
  process.exit(2);
}
// Integers >= 1: NaN would make `busy >= maxParallel` never true (unbounded parallel runs) and setTimeout(NaN) a hot loop (R20).
const maxParallel = Number(values["max-parallel"]);
const pollS = Number(values["poll-s"]);
for (const [flag, v] of [["--max-parallel", maxParallel], ["--poll-s", pollS]] as const) {
  if (!Number.isInteger(v) || v < 1) {
    console.error(`${flag} must be an integer >= 1`);
    process.exit(2);
  }
}
const headEveryMin = values["head-every-min"] !== undefined ? Number(values["head-every-min"]) : undefined;
if (headEveryMin !== undefined && (!Number.isFinite(headEveryMin) || headEveryMin <= 0)) {
  console.error("--head-every-min must be a positive number of minutes");
  process.exit(2);
}

if (values["head-now"] && headEveryMin === undefined) {
  console.error("--head-now needs --head-every-min (the head cycle is off without it)");
  process.exit(2);
}

const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
const board = boardFromEnv(naive);
const { ok, errors } = await loadAllAgents();
for (const e of errors) console.warn(`skipping agents/${e.agent}: ${e.message}`);
// studio-head runs only by cadence (--head-every-min) or the window chat, never from a board card: a card for it would
// start a second head beside the cadence turn (R20).
const specs = new Map(ok.filter((s) => s.runner === "local" && s.name !== "studio-head").map((s) => [s.name, s]));
if (!specs.size) throw new Error("no local agent specs found under agents/");

// Approval gate for dispatched runs (rule 4): the durable queue by default (the operator decides
// from `npm run approvals`; unanswered requests expire after --approval-timeout-min), --approve-all
// decides immediately as auto for tests. Both paths ledger the decision.
// Queue mode only: dispatched runs are parallel and unattended, so a tty prompt is never right here.
const approver: Approver = buildApprover({ approveAll: values["approve-all"] === true, approvalsMode: "queue", approvalTimeoutMs: approvalTimeoutMin * 60_000 });

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
  maxParallel,
  pollS,
  once: values.once,
  ...(head && headEveryMin !== undefined
    ? {
        headEveryMin,
        head: { spec: head, task: HEAD_TASK, provider: (spec: typeof head) => providerFor(spec, naive) },
        hasGreenlightPick: () => hasGreenlightPick(),
        headNow: values["head-now"],
      }
    : {}),
  log: (l) => console.log(l),
});
