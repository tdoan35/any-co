// Validates the adapter's output for the REAL runs/ and agents/ against the UI contract.
// `npm run window:check`. Exits non-zero on any mismatch.
import { RegistrySchema, RunEventPayloadSchemas, RunEventSchema, RunSchema, TaskSchema, WeaveSnapshotSchema } from "@fabric/contracts";
import { z } from "zod";
import { startServer } from "./index.ts";

const srv = await startServer({ port: 0 });
const get = async (p: string) => (await fetch(`http://127.0.0.1:${srv.port}/api${p}`)).json();
try {
  const runs = z.array(RunSchema).parse(await get("/runs"));
  z.array(TaskSchema).parse(await get("/tasks"));
  const reg = RegistrySchema.parse(await get("/registry"));
  const weave = WeaveSnapshotSchema.parse(await get("/weave"));
  let events = 0;
  for (const r of runs) {
    for (const e of z.array(RunEventSchema).parse(await get(`/runs/${r.id}/events`))) { RunEventPayloadSchemas[e.type].parse(e.payload); events++; }
    console.log(`${r.status.padEnd(8)} $${r.costUsd.toFixed(4)} ${String(r.segments.length).padStart(2)} steps  ${r.id}`);
  }
  console.log(`OK: ${runs.length} runs, ${events} events, ${reg.agents.length} agents, ${reg.teams.length} teams, ${weave.pulse.length} pulse entries`);
} finally {
  await srv.close();
}
