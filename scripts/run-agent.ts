// Run one agent locally on one task.
//   npm run agent -- <name> --task "..." | --task-file path   [--model id] [--max-usd 0.25] [--approve-all]
//   [--approvals tty|queue] [--approval-timeout-min 30] — approval gate; queue is the default off-terminal.
// Output goes to runs/<run_id>/ (gitignored). `touch runs/KILL` stops every run before its next call.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadAgent } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { runAgent, type Approver } from "../runner/run.ts";
import { decide, get, queueApprover, request } from "../tools/approvals/approvals.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: "string" },
    "task-file": { type: "string" },
    model: { type: "string" },
    "max-usd": { type: "string" },
    "approve-all": { type: "boolean", default: false },
    approvals: { type: "string" }, // tty | queue
    "approval-timeout-min": { type: "string" },
  },
});
const name = positionals[0];
const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
if (!name || !task) {
  console.error('usage: npm run agent -- <name> --task "..." | --task-file path [--model id] [--max-usd N] [--approve-all] [--approvals tty|queue] [--approval-timeout-min N]');
  process.exit(2);
}
const approvalsMode = values.approvals ?? (process.stdin.isTTY ? "tty" : "queue");
if (approvalsMode !== "tty" && approvalsMode !== "queue") {
  console.error("--approvals must be tty or queue");
  process.exit(2);
}
const approvalTimeoutMin = Number(values["approval-timeout-min"] ?? 30);
if (!Number.isFinite(approvalTimeoutMin) || approvalTimeoutMin <= 0) {
  console.error("--approval-timeout-min must be a positive number of minutes");
  process.exit(2);
}
const approvalTimeoutMs = approvalTimeoutMin * 60_000;

const spec = await loadAgent(name);
if (spec.runner !== "local") console.warn(`note: ${name} is runner: ${spec.runner}; running it locally anyway`);
const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
const provider = providerFor(spec, naive, values.model);

// Approval gate for `ask` tools. Every path records the request in the approval queue and ledgers
// the decision (rule 4): --approve-all decides immediately as "auto", tty asks the human at the
// terminal, queue waits for `npm run approvals` and expires after --approval-timeout-min.
const approver: Approver = values["approve-all"]
  ? async (req) => (decide(request(req), true, "auto (--approve-all)"), true)
  : approvalsMode === "queue"
    ? queueApprover({ timeoutMs: approvalTimeoutMs })
    : async (req) => {
        const id = request(req);
        if (!process.stdin.isTTY) return (decide(id, false, "auto (no tty)"), false);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const a = await rl.question(`\n[approval ${id}] ${req.agent} wants ${req.tool} ${JSON.stringify(req.input).slice(0, 400)}\nallow? [y/N] `);
        rl.close();
        // The CLI may decide the same request while the prompt is open; return the folded state, not the y/N.
        const allow = a.trim().toLowerCase() === "y";
        const decided = decide(id, allow, "operator", allow ? undefined : "declined at the terminal");
        return decided ? decided.state === "approved" : get(id)?.state === "approved";
      };

const maxUsd = values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined;
console.log(`running ${name} on ${provider.label}`);
const r = await runAgent(spec, { task, provider, naive, approver, runCapUsd: maxUsd, log: (l) => console.log("  " + l) });
console.log(`\n${r.status} in ${r.turns} turns, spent $${(r.spent_micro_usd / 1e6).toFixed(5)}  →  ${r.dir}`);
if (r.error) console.log(`error: ${r.error.split("\n")[0]}`);
if (r.output !== null) console.log(typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2));
process.exit(r.status === "done" ? 0 : 1);
