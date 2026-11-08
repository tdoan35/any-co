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
