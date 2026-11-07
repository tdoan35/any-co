// The studio loop (T4): poll the board, run local agents on due cards, close the cards.
//   npm run studio -- [--max-parallel 2] [--poll-s 10] [--once] [--approve-all]
// Board backend: STUDIO_BOARD=local (default; runs/board.jsonl, override with STUDIO_BOARD_FILE)
// or STUDIO_BOARD=naive (needs NAIVE_API_KEY and STUDIO_BOARD_REF, the Studio Head's brd_/agt_ id).
// `touch runs/KILL` stops dispatch between passes and kills in-flight runs at their next call.
import { parseArgs } from "node:util";
import { loadAllAgents } from "../runner/load.ts";
import { naiveClient, providerFor } from "../runner/providers.ts";
import { boardFromEnv } from "../runner/board/index.ts";
import { studioLoop } from "../runner/dispatch.ts";

const { values } = parseArgs({
  options: {
    "max-parallel": { type: "string", default: "2" },
    "poll-s": { type: "string", default: "10" },
    once: { type: "boolean", default: false },
    "approve-all": { type: "boolean", default: false },
  },
});

const naive = process.env.NAIVE_API_KEY ? naiveClient() : null;
const board = boardFromEnv(naive);
const { ok, errors } = await loadAllAgents();
for (const e of errors) console.warn(`skipping agents/${e.agent}: ${e.message}`);
const specs = new Map(ok.filter((s) => s.runner === "local").map((s) => [s.name, s]));
if (!specs.size) throw new Error("no local agent specs found under agents/");
console.log(`studio loop: ${specs.size} local agent(s), board ${process.env.STUDIO_BOARD ?? "local"}${values.once ? ", one pass" : `, polling every ${values["poll-s"]}s`}`);

await studioLoop({
  board,
  specs,
  provider: (spec) => providerFor(spec, naive),
  naive,
  // default gate denies every ask; --approve-all mirrors npm run agent's escape hatch
  approver: values["approve-all"] ? async () => true : undefined,
  maxParallel: Number(values["max-parallel"]),
  pollS: Number(values["poll-s"]),
  once: values.once,
  log: (l) => console.log(l),
});
