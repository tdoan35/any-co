// List and resume local runs (crash recovery, AGENTS.md rule 7).
//   npm run runs -- orphans                       list runs stuck at "running" whose process is gone
//   npm run runs -- resume <run_id> [--max-usd N] [--model id] [--approve-all]
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAgent } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { RUNS_DIR, type Approver } from "../runner/run.ts";
import { resumeRun } from "../runner/resume.ts";
import { listOrphans } from "../runner/liveness.ts";

/** Shared by `npm run agent -- --resume <run_id>`: load the run's spec and continue it. */
export async function resumeCli(runId: string, o: { maxUsd?: number; model?: string; approveAll?: boolean }): Promise<void> {
  let agent: string;
  try {
    agent = JSON.parse(readFileSync(path.join(RUNS_DIR, runId, "run.json"), "utf8")).agent;
  } catch (e) {
    console.error(`cannot read run "${runId}" under runs/: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const spec = await loadAgent(agent);
  const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
  const provider = providerFor(spec, naive, o.model);
  // Approval gate for `ask` tools: interactive y/N on a terminal, deny otherwise.
  const approver: Approver = o.approveAll
    ? async () => true
    : async (req) => {
        if (!process.stdin.isTTY) return false;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const a = await rl.question(`\n[approval] ${req.agent} wants ${req.tool} ${JSON.stringify(req.input).slice(0, 400)}\nallow? [y/N] `);
        rl.close();
        return a.trim().toLowerCase() === "y";
      };
  console.log(`resuming ${runId} (${agent}) on ${provider.label}`);
  let r;
  try {
    r = await resumeRun(spec, runId, { provider, naive, approver, runCapUsd: o.maxUsd, log: (l) => console.log("  " + l) });
  } catch (e) {
    console.error(`cannot resume ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  console.log(`\n${r.status} in ${r.turns} turns, spent $${(r.spent_micro_usd / 1e6).toFixed(5)}  →  ${r.dir}`);
  if (r.error) console.log(`error: ${r.error.split("\n")[0]}`);
  if (r.output !== null) console.log(typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2));
  process.exit(r.status === "done" ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      "max-usd": { type: "string" },
      "approve-all": { type: "boolean", default: false },
    },
  });
  if (positionals[0] === "orphans") {
    const orphans = listOrphans(RUNS_DIR);
    if (!orphans.length) console.log("no orphaned runs");
    for (const o of orphans) {
      const spent = o.spent_micro_usd !== undefined ? `  $${(o.spent_micro_usd / 1e6).toFixed(4)}` : "";
      console.log(`${o.run_id}  ${o.agent ?? "?"}${spent}  turns ${o.turns ?? "?"}  — ${o.reason}`);
    }
    if (orphans.length) console.log("\nresume with: npm run runs -- resume <run_id>");
    process.exit(0);
  }
  if (positionals[0] === "resume" && positionals[1]) {
    await resumeCli(positionals[1], {
      maxUsd: values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined,
      model: values.model,
      approveAll: values["approve-all"],
    });
  } else {
    console.error("usage: npm run runs -- orphans | resume <run_id> [--max-usd N] [--model id] [--approve-all]");
    process.exit(2);
  }
}
