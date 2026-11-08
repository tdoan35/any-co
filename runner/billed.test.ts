import { test } from "node:test";
import assert from "node:assert/strict";
import { NaiveProvider } from "./providers.ts";

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], max_tokens: 100 };
function fakeClient(traces: Array<"missing" | number>) {
  let n = 0;
  return {
    proxy: {
      messages: async () => ({ id: `req_${++n}`, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }),
      call: async () => {
        const t = traces.shift() ?? "missing";
        if (t === "missing") throw Object.assign(new Error("no proxy call trace with that id"), { status: 404 });
        return { billed_micro_usd: t };
      },
    },
  } as any;
}

test("a late trace is used; a missing trace becomes a marked conservative estimate instead of failing the run", async () => {
  const saved = NaiveProvider.TRACE_WAITS_MS;
  NaiveProvider.TRACE_WAITS_MS = [1, 1, 1];
  try {
    // call 1: trace appears on the 2nd lookup (1100 micro-USD for 1100 tokens = 1 micro/token)
    // call 2: trace never appears -> estimate = 1100 tokens * 1 micro/token * 1.5 = 1650
    const p = new NaiveProvider(fakeClient(["missing", 1100, "missing", "missing", "missing"]), "m", "immediate");
    const a = await p.complete(req);
    assert.equal(a.cost_micro_usd, 1100);
    assert.equal(a.cost_estimated, undefined);
    const b = await p.complete(req);
    assert.equal(b.cost_estimated, true);
    assert.equal(b.cost_micro_usd, 1650);
    // no billed history yet -> the ceiling ($5/$25 per MTok): 1000*5 + 100*25 = 7500
    const fresh = new NaiveProvider(fakeClient(["missing", "missing", "missing"]), "m", "immediate");
    const c = await fresh.complete(req);
    assert.equal(c.cost_estimated, true);
    assert.equal(c.cost_micro_usd, 7500);
  } finally {
    NaiveProvider.TRACE_WAITS_MS = saved;
  }
});
