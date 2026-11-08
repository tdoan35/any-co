import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_TRIES, retryWaitMs } from "./providers.ts";

test("429s wait for the gateway's per-minute window; other transient errors back off fast", () => {
  const rl = { status: 429 };
  assert.ok(retryWaitMs(rl, 1, 1000) >= 15_000 && retryWaitMs(rl, 1, 1000) < 16_000);
  assert.ok(retryWaitMs(rl, 3, 1000) >= 45_000);
  assert.ok(retryWaitMs(rl, 7, 1000) >= 60_000 && retryWaitMs(rl, 7, 1000) < 61_000, "capped at a minute");
  assert.ok(retryWaitMs({ status: 503 }, 1, 1000) < 1_300);
  assert.ok(RATE_LIMIT_TRIES >= 6, "enough tries to outlast a one-minute window several times");
});

// ---- T32: network-level failures ("TypeError: fetch failed") ride out a dropped connection ----

import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  NETWORK_WAITS_MS, NaiveProvider, OpenAICompatibleProvider, isTransient, networkCode, networkLevel, networkWaitMs, retryClock, withRetry,
} from "./providers.ts";
import { loadAgent } from "./load.ts";
import { runAgent } from "./run.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "agents");
const reset = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

/** Run fn with millisecond backoff and console.warn captured. */
async function fast<T>(fn: (warnings: string[]) => Promise<T>): Promise<T> {
  const prev = retryClock.baseMs;
  const warn = console.warn;
  const warnings: string[] = [];
  retryClock.baseMs = 1;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    return await fn(warnings);
  } finally {
    retryClock.baseMs = prev;
    console.warn = warn;
  }
}

test("T32: network-level failures are recognized by the TypeError or by a socket code anywhere in the cause chain", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
    const e = new TypeError("fetch failed", { cause: { code } });
    assert.equal(networkLevel(e), true, code);
    assert.equal(networkCode(e), code);
    assert.equal(isTransient(e), true);
  }
  assert.equal(networkLevel(new TypeError("fetch failed")), true, "no cause at all");
  const happyEyeballs = new TypeError("fetch failed", { cause: Object.assign(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ENETUNREACH" }]), {}) });
  assert.equal(networkCode(happyEyeballs), "ECONNREFUSED");
  assert.equal(networkLevel(Object.assign(new Error("Bad Gateway"), { status: 502 })), false, "an HTTP answer is not network-level");
  assert.equal(networkLevel(new TypeError("x is not a function")), false);
  assert.equal(isTransient(Object.assign(new Error("budget.exceeded"), { status: 400 })), false);
});

test("T32: the network schedule is 2 s, 5 s, 15 s, 30 s, 30 s (6 tries) at the production base", () => {
  assert.deepEqual(NETWORK_WAITS_MS, [2000, 5000, 15_000, 30_000, 30_000]);
  for (let n = 1; n <= 7; n++) {
    const w = networkWaitMs(n, 1000);
    const base = NETWORK_WAITS_MS[Math.min(n, 5) - 1];
    assert.ok(w >= base && w < base + 250, `retry ${n}: ${w}`);
  }
  assert.ok(networkWaitMs(5, 1) <= 31, "scaled for tests");
});

test("T32: fetch throws TypeError('fetch failed', ECONNRESET) twice, then answers → the run continues to done", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls <= 2) throw reset();
    return new Response(JSON.stringify({
      id: "c1", model: "m",
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "t1", function: { name: "submit_result", arguments: JSON.stringify({ answer: "ok" }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fast(async (warnings) => {
      const spec = await loadAgent("good-agent", FIX);
      const provider = new OpenAICompatibleProvider("http://gateway.invalid/v1", "k", "m", { input: 1, output: 1 });
      const r = await runAgent(spec, { task: "t", provider, naive: null, runsDir: mkdtempSync(path.join(tmpdir(), "t32-")) });
      assert.equal(r.status, "done", JSON.stringify(r));
      assert.deepEqual(r.output, { answer: "ok" });
      assert.equal(calls, 3);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /openai:m: network error \(fetch failed \[ECONNRESET\]\), retry 1\/5 in \d+ ms/);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("T32: the Naïve provider retries a dropped socket the same way", async () => {
  let calls = 0;
  const client = {
    proxy: {
      messages: async () => {
        if (++calls <= 2) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
        return { id: "msg_1", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } };
      },
      call: async () => ({ billed_micro_usd: 42 }),
    },
  } as any;
  await fast(async () => {
    const reply = await new NaiveProvider(client, "z-ai/glm-5.3", "immediate").complete({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], max_tokens: 10 } as any);
    assert.equal(calls, 3);
    assert.equal(reply.cost_micro_usd, 42);
  });
});

test("T32: a permanent network failure surfaces after the bound, naming the code and the attempts", async () => {
  let n = 0;
  await fast(async (warnings) => {
    const err = await withRetry(async () => { n++; throw reset(); }, "naive:m").catch((e: unknown) => e as Error);
    assert.equal(n, NETWORK_WAITS_MS.length + 1);
    assert.equal(warnings.length, NETWORK_WAITS_MS.length);
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /^fetch failed \(ECONNRESET, after 6 tries over naive:m\)$/);
  });
});

test("T32: our own request timeout (TimeoutError / AbortError) is retried at most once", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    let n = 0;
    await fast(async () => {
      const err = await withRetry(async () => { n++; throw new DOMException("The operation was aborted due to timeout", name); }, "t").catch((e: unknown) => e);
      assert.equal(n, 2, name);
      assert.equal((err as DOMException).name, name);
    });
  }
  // a timeout then a reset then success: both kinds retried in one call
  let m = 0;
  await fast(async () => {
    const v = await withRetry(async () => {
      m++;
      if (m === 1) throw new DOMException("timeout", "TimeoutError");
      if (m === 2) throw reset();
      return "ok";
    }, "t");
    assert.equal(v, "ok");
  });
});

test("a poisoned pooled connection (ERR_HTTP2_INVALID_SESSION, TLS BAD_RECORD_MAC) resets the fetch dispatcher before the retry", async () => {
  const { withRetry, connectionResets } = await import("./providers.ts");
  const before = connectionResets.count;
  const poisoned = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls === 1) throw poisoned("ERR_HTTP2_INVALID_SESSION");
    if (calls === 2) throw poisoned("ERR_SSL_TLS_ALERT_BAD_RECORD_MAC");
    return "ok";
  }, "test", 5, 1);
  assert.equal(out, "ok");
  assert.equal(connectionResets.count - before, 2, "one reset per poisoned failure");
  // a plain reset-by-peer is a network blip, not a poisoned pool: no dispatcher reset
  let n = 0;
  await withRetry(async () => { if (n++ === 0) throw poisoned("ECONNRESET"); return 1; }, "test", 5, 1);
  assert.equal(connectionResets.count - before, 2);
});
