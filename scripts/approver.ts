// The one approval-gate construction shared by every CLI entry point (run-agent, runs resume),
// so a resumed run goes through the same queue and ledger as a fresh one (AGENTS.md rule 4).
// Every path records the request in the approvals queue and ledgers the decision:
// --approve-all decides immediately as "auto", queue waits for `npm run approvals` and expires
// after timeoutMs, tty asks the human at the terminal.
import { createInterface } from "node:readline/promises";
import { decide, get, queueApprover, request } from "../tools/approvals/approvals.ts";
import type { Approver } from "../runner/run.ts";

export interface ApproverCliOptions {
  approveAll: boolean;
  approvalsMode: "tty" | "queue";
  approvalTimeoutMs: number;
}

export function buildApprover(o: ApproverCliOptions): Approver {
  if (o.approveAll) {
    return async (req) => (decide(request(req), true, "auto (--approve-all)"), true);
  }
  if (o.approvalsMode === "queue") {
    return queueApprover({ timeoutMs: o.approvalTimeoutMs });
  }
  return async (req) => {
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
}

/** Parse and validate the approval flags shared by the CLIs; exits on bad values. */
export function approvalFlags(v: Record<string, unknown>): ApproverCliOptions {
  const approvalsMode = (v.approvals as string | undefined) ?? (process.stdin.isTTY ? "tty" : "queue");
  if (approvalsMode !== "tty" && approvalsMode !== "queue") {
    console.error("--approvals must be tty or queue");
    process.exit(2);
  }
  const timeoutMin = Number(v["approval-timeout-min"] ?? 30);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    console.error("--approval-timeout-min must be a positive number of minutes");
    process.exit(2);
  }
  return { approveAll: v["approve-all"] === true, approvalsMode, approvalTimeoutMs: timeoutMin * 60_000 };
}
