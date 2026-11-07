// Test aid spawned by runner/resume.test.ts: runs good-agent on a FakeProvider and SIGKILLs
// itself at a chosen transcript event, leaving a genuinely crashed run behind — no end event,
// run.json stuck at "running". Never used outside tests.
//   node --import tsx runner/__fixtures__/crash-run.ts <runsDir> <killAt> <stepsJson> [approveAll]
// killAt "<type>" or "<type>:<detail>": matches the event type and, for msg, its role, for
// tool/approval, its name. The transcript line is fully written before the kill lands.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../load.ts";
import { FakeProvider } from "../providers.ts";
import { runAgent } from "../run.ts";
import type { ModelReply } from "../types.ts";

const [runsDir, killAt, stepsJson, approveAll] = process.argv.slice(2) as [string, string, string, string | undefined];
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const spec = await loadAgent("good-agent", FIX);
const [type, detail] = killAt.split(":");
const fake = new FakeProvider(JSON.parse(stepsJson) as Array<Partial<ModelReply>>);
const r = await runAgent(spec, {
  task: "crash test",
  provider: fake,
  naive: null,
  runsDir,
  approver: approveAll === "1" ? async () => true : undefined,
  onEvent: (t, d) => {
    if (t !== type) return;
    if (detail && !((t === "msg" && d.role === detail) || d.name === detail)) return;
    process.kill(process.pid, "SIGKILL");
  },
});
console.log(JSON.stringify({ status: r.status, turns: r.turns, spent: r.spent_micro_usd }));
