import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, loadAllAgents, specHash, toNaiveAgent } from "./load.ts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "agents");

test("valid spec loads with defaults and converts to a Naïve body", async () => {
  const s = await loadAgent("good-agent", FIX);
  assert.equal(s.provider.kind, "naive");
  assert.equal(s.harness, "pi");
  assert.equal(s.limits.max_turns, 30);
  const body: any = toNaiveAgent(s);
  assert.deepEqual(body.budget, { cap_micro_usd: 2_000_000, max_task_micro_usd: 500_000, period: "day" });
  assert.equal(body.tools.default_config.permission, "deny");
  assert.deepEqual(body.tools.configs.web_fetch, { enabled: true, permission: "allow" });
  assert.deepEqual(body.tools.configs.write, { enabled: true, permission: "ask" });
  assert.equal(body.tools.configs.bash, undefined);
  assert.equal(body.structured_output_required, true);
  assert.equal(body.output_schema.type, "object");
  assert.match(body.metadata.spec_hash, /^[0-9a-f]{16}$/);
});

test("spec hash is stable and changes with the spec", async () => {
  const a = await loadAgent("good-agent", FIX);
  const b = await loadAgent("good-agent", FIX);
  assert.equal(specHash(a), specHash(b));
  assert.notEqual(specHash(a), specHash({ ...a, model: "other/model" }));
});

test("invalid specs are rejected with readable reasons", async () => {
  const { ok, errors } = await loadAllAgents(FIX);
  assert.deepEqual(ok.map((s) => s.name), ["good-agent", "image-agent", "send-agent"]);
  const msg = Object.fromEntries(errors.map((e) => [e.agent, e.message]));
  assert.match(msg["bad-budget"], /max_task_usd must be <= cap_usd/);
  assert.match(msg["wrong-name"], /must match folder/);
  assert.match(msg["bad-tool"], /unknown capability "teleport"/);
  assert.match(msg["external-hosted"], /runner: naive requires provider: naive/);
});

test("every real agent spec in agents/ is valid", async () => {
  const { errors } = await loadAllAgents();
  assert.deepEqual(errors.map((e) => e.message), []);
});
