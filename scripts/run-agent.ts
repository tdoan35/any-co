// Run one agent locally on one task.
//   npm run agent -- <name> --task "..." | --task-file path   [--model id] [--max-usd 0.25] [--approve-all]
//   npm run agent -- --resume <run_id>   [--max-usd N]        continue a crashed run (see scripts/runs.ts)
//   [--approvals tty|queue] [--approval-timeout-min 30] — approval gate; queue is the default off-terminal.
// Output goes to runs/<run_id>/ (gitignored). `touch runs/KILL` stops every run before its next call.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadAgent } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { runAgent } from "../runner/run.ts";
import { resumeCli } from "./runs.ts";
import { approvalFlags, buildApprover } from "./approver.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: "string" },
    "task-file": { type: "string" },
    model: { type: "string" },
    "max-usd": { type: "string" },
    "approve-all": { type: "boolean", default: false },
    resume: { type: "string" },
    approvals: { type: "string" }, // tty | queue
    "approval-timeout-min": { type: "string" },
  },
});
// Crash recovery: continue an orphaned run (same id, workspace, spend). scripts/runs.ts owns the flow.
if (values.resume) {
  await resumeCli(values.resume, { maxUsd: values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined, model: values.model, flags: values });
  process.exit(0); // resumeCli exits with the run's status; this is unreachable
}

const name = positionals[0];
const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
if (!name || !task) {
  console.error('usage: npm run agent -- <name> --task "..." | --task-file path [--model id] [--max-usd N] [--approve-all] [--resume <run_id>] [--approvals tty|queue] [--approval-timeout-min N]');
  process.exit(2);
}
const approver = buildApprover(approvalFlags(values));

const spec = await loadAgent(name);
if (spec.runner !== "local") console.warn(`note: ${name} is runner: ${spec.runner}; running it locally anyway`);
const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
const provider = providerFor(spec, naive, values.model);

const maxUsd = values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined;
console.log(`running ${name} on ${provider.label}`);
const r = await runAgent(spec, { task, provider, naive, approver, runCapUsd: maxUsd, log: (l) => console.log("  " + l) });
console.log(`\n${r.status} in ${r.turns} turns, spent $${(r.spent_micro_usd / 1e6).toFixed(5)}  →  ${r.dir}`);
if (r.error) console.log(`error: ${r.error.split("\n")[0]}`);
if (r.output !== null) console.log(typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2));
process.exit(r.status === "done" ? 0 : 1);
