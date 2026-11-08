// Test aid spawned by runner/resume.test.ts and runner/images.test.ts: runs a fixture agent on
// a FakeProvider and SIGKILLs itself at a chosen transcript event, leaving a genuinely crashed
// run behind — no end event, run.json stuck at "running". Never used outside tests.
//   node --import tsx runner/__fixtures__/crash-run.ts <runsDir> <killAt> <stepsJson> [approveAll] [agent]
// killAt "<type>" or "<type>:<detail>": matches the event type and, for msg, its role, for
// tool/approval, its name. The transcript line is fully written before the kill lands.
// The image agent gets the ground-truth PNG copied into its workspace first.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../load.ts";
import { FakeProvider } from "../providers.ts";
import { runAgent } from "../run.ts";
import type { ModelReply } from "../types.ts";

const [runsDir, killAt, stepsJson, approveAll, agentName] = process.argv.slice(2) as [string, string, string, string | undefined, string | undefined];
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const agent = agentName ?? "good-agent";
if (agent === "image-agent") {
  const workspace = path.join(runsDir, "crash-image-agent", "workspace");
  mkdirSync(workspace, { recursive: true });
  copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "img", "tiny.png"), path.join(workspace, "img.png"));
}
const spec = await loadAgent(agent, FIX);
const [type, detail] = killAt.split(":");
const fake = new FakeProvider(JSON.parse(stepsJson) as Array<Partial<ModelReply>>);
const r = await runAgent(spec, {
  task: "crash test",
  provider: fake,
  naive: null,
  runsDir,
  approver: approveAll === "1" ? async () => true : undefined,
  runId: `crash-${agent}`,
  onEvent: (t, d) => {
    if (t !== type) return;
    if (detail && !((t === "msg" && d.role === detail) || d.name === detail)) return;
    process.kill(process.pid, "SIGKILL");
  },
});
console.log(JSON.stringify({ status: r.status, turns: r.turns, spent: r.spent_micro_usd }));
