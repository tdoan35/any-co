// Agent spec CLI.
//   npm run agents -- list                 validate every spec, one line each
//   npm run agents -- show <name>          print the resolved spec and its Naïve agents.create body
//   npm run agents -- validate [--remote]  exit 1 on any invalid spec; --remote also checks models exist on Naïve
import { createClient } from "@usenaive-sdk/managed-agents";
import { loadAgent, loadAllAgents, specHash, toNaiveAgent } from "../runner/load.ts";
import { CAPABILITIES } from "../runner/tools/registry.ts";

const [cmd = "list", arg] = process.argv.slice(2);

if (cmd === "list" || cmd === "validate") {
  const { ok, errors } = await loadAllAgents();
  for (const s of ok) {
    const missing = Object.keys(s.tools).filter((c) => !CAPABILITIES[c as keyof typeof CAPABILITIES].local);
    console.log(
      `ok   ${s.name.padEnd(24)} ${s.runner.padEnd(5)} ${s.model.padEnd(28)} $${s.budget.max_task_usd}/task $${s.budget.cap_usd}/${s.budget.period}` +
        (missing.length && s.runner === "local" ? `  (no local impl yet: ${missing.join(", ")})` : ""),
    );
  }
  for (const e of errors) console.log(`FAIL ${e.message}`);
  let failed = errors.length > 0;
  if (cmd === "validate" && process.argv.includes("--remote")) {
    const apiKey = process.env.NAIVE_API_KEY;
    if (!apiKey) throw new Error("--remote needs NAIVE_API_KEY");
    const c = createClient({ apiKey, baseUrl: process.env.NAIVE_BASE_URL ?? "https://api.vetta.sh" });
    for (const s of ok) {
      try {
        await c.models.retrieve(s.model);
      } catch (e: any) {
        failed = true;
        console.log(`FAIL ${s.name}: model ${s.model} not in Naïve catalogue (${e?.status ?? e})`);
      }
    }
  }
  if (cmd === "validate" && failed) process.exit(1);
} else if (cmd === "show" && arg) {
  const s = await loadAgent(arg);
  const { system, ...rest } = toNaiveAgent(s) as Record<string, unknown>;
  console.log(JSON.stringify({ spec_hash: specHash(s), runner: s.runner, provider: s.provider, limits: s.limits, naive_body: rest }, null, 2));
  console.log(`--- system (${String(system).length} chars) ---\n${system}`);
} else {
  console.error("usage: npm run agents -- list | show <name> | validate [--remote]");
  process.exit(2);
}
