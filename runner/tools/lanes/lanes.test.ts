import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { mergeCapabilities, mergeImpls } from "./merge.ts";
import { LANES } from "./index.ts";
import type { LaneModule } from "./types.ts";
import { CAPABILITIES, CORE_CAPABILITIES } from "../registry.ts";
import { IMPLS, TOOL_INDEX, type ToolImpl } from "../impl.ts";
import { AgentSpecInput, grantIssues } from "../../spec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tool = (text: string): ToolImpl => ({ description: `fixture tool: ${text}`, input: z.object({}).strict(), run: async () => ({ content: text }) });
const coreImpls = IMPLS as Record<string, Record<string, ToolImpl>>;

/** A fixture lane: one read-only capability and one outward (send) capability. */
const fixture: LaneModule = {
  CAPABILITIES: {
    fixture_ping: { summary: "Fixture: answers pong", naive: [], local: true, outward: false },
    fixture_post: { summary: "Fixture: posts somewhere public", naive: ["bash"], local: true, outward: true },
  },
  IMPLS: { fixture_ping: { fixture_ping: tool("pong") }, fixture_post: { fixture_post: tool("posted") } },
};

test("a fixture lane adds capabilities; an agent can be granted them (outward only as ask)", async () => {
  const caps = mergeCapabilities(CORE_CAPABILITIES, { fixture });
  const impls = mergeImpls(coreImpls, { fixture });
  assert.ok(caps.fixture_ping && caps.board, "core and lane capabilities side by side");
  assert.deepEqual(grantIssues({ fixture_ping: "allow", fixture_post: "ask", board: "allow" }, caps), []);
  assert.equal((await impls.fixture_ping.fixture_ping.run({}, { workspace: HERE, naive: null })).content, "pong");
  // no default grants: a capability nobody names stays unknown to a spec checked against core only
  assert.match(grantIssues({ fixture_ping: "allow" })[0].message, /unknown capability "fixture_ping"/);
});

test("an outward lane capability granted allow is refused by validation", () => {
  const caps = mergeCapabilities(CORE_CAPABILITIES, { fixture });
  const issues = grantIssues({ fixture_post: "allow" }, caps);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /sends or spends outside the studio: grant it "ask"/);
  assert.deepEqual(grantIssues({ fixture_post: "deny" }, caps), []);
});

test("core sends are outward too: a real spec granting itch_push allow fails validation", () => {
  for (const cap of ["itch_push", "email_send", "site_deploy"] as const) assert.equal(CAPABILITIES[cap].outward, true, cap);
  const base = { name: "t-agent", description: "fixture agent for lanes", dept: "test", runner: "local", model: "m", budget: { cap_usd: 1, max_task_usd: 1, period: "day" } } as const;
  assert.equal(AgentSpecInput.safeParse({ ...base, tools: { itch_push: "ask" } }).success, true);
  const bad = AgentSpecInput.safeParse({ ...base, tools: { itch_push: "allow" } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /grant it \\"ask\\"/);
});

test("redefining a core or another lane's capability, or shadowing a tool name, fails loudly at load", () => {
  const lane = (caps: LaneModule["CAPABILITIES"], impls: LaneModule["IMPLS"]): LaneModule => ({ CAPABILITIES: caps, IMPLS: impls });
  const ping = { summary: "x", naive: [], local: true, outward: false };
  assert.throws(() => mergeCapabilities(CORE_CAPABILITIES, { evil: lane({ board: ping }, { board: { x_tool: tool("x") } }) }), /lane "evil" redefines core capability "board"/);
  assert.throws(() => mergeCapabilities(CORE_CAPABILITIES, { a: lane({ dup_cap: ping }, {}), b: lane({ dup_cap: ping }, {}) }), /lane "b" redefines capability "dup_cap" from lane "a"/);
  assert.throws(() => mergeImpls(coreImpls, { evil: lane({ evil_cap: ping }, { evil_cap: { board_list: tool("x") } }) }), /tool "board_list" shadows the tool of core capability "board"/);
  assert.throws(() => mergeImpls(coreImpls, { evil: lane({ evil_cap: ping }, { evil_cap: { submit_result: tool("x") } }) }), /shadows the tool of the runner/);
  assert.throws(() => mergeImpls(coreImpls, { a: lane({ a_cap: ping }, { a_cap: { same_tool: tool("a") } }), b: lane({ b_cap: ping }, { b_cap: { same_tool: tool("b") } }) }), /lane "b" tool "same_tool" shadows the tool of lane "a"/);
  assert.throws(() => mergeImpls(coreImpls, { evil: lane({}, { board: { x_tool: tool("x") } }) }), /implements capability "board" that it does not declare/);
  assert.throws(() => mergeImpls(coreImpls, { lazy: lane({ lazy_cap: ping }, {}) }), /declares capability "lazy_cap" as local but has no IMPLS/);
  assert.throws(() => mergeCapabilities(CORE_CAPABILITIES, { bad: lane({ "Bad-Name": ping }, {}) }), /must be snake_case/);
});

test("the real lanes load: marketing is registered, every lane capability is in the registry and the tool index", () => {
  assert.ok("marketing" in LANES);
  for (const [lane, mod] of Object.entries(LANES as unknown as Record<string, LaneModule>)) {
    for (const cap of Object.keys(mod.CAPABILITIES)) assert.ok(cap in CAPABILITIES, `${lane}.${cap} in CAPABILITIES (agents validate sees it)`);
    for (const tools of Object.values(mod.IMPLS)) for (const t of Object.keys(tools)) assert.ok(t in TOOL_INDEX, `${lane} tool ${t} in TOOL_INDEX`);
  }
  // the core stays whole after the merge
  for (const cap of Object.keys(CORE_CAPABILITIES)) assert.ok(cap in IMPLS, cap);
});

test("lane modules never import impl.ts or registry.ts at runtime (that would be a load cycle)", () => {
  const infra = new Set(["index.ts", "merge.ts", "types.ts"]);
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !infra.has(f))) {
    const src = readFileSync(path.join(HERE, f), "utf8");
    for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']([^"']+)["']/gm))
      assert.ok(!/(^|\/)(impl|registry)\.ts$/.test(m[1]), `${f} imports ${m[1]} at runtime; use ../kit.ts (or import type)`);
  }
});

test("a lane capability must declare outward explicitly (R25: a forgotten marker is not an ungated send)", () => {
  const silent: LaneModule = { CAPABILITIES: { reddit_post_x: { summary: "posts", naive: [], local: true } as any }, IMPLS: { reddit_post_x: { reddit_post_x: tool("x") } } };
  assert.throws(() => mergeCapabilities(CORE_CAPABILITIES, { silent }), /must declare outward/);
});

test("T27: dryRunField must be a boolean defaulting to true, for core and lane tools", () => {
  const ping = { summary: "x", naive: [], local: true, outward: true };
  const withField = (field: z.ZodType, name = "dry_run"): ToolImpl => ({ ...tool("x"), input: z.object({ [name]: field }).strict(), dryRunField: "dry_run" });
  const lane = (impl: ToolImpl): LaneModule => ({ CAPABILITIES: { send_cap: ping }, IMPLS: { send_cap: { send_tool: impl } } });
  assert.doesNotThrow(() => mergeImpls(coreImpls, { ok: lane(withField(z.boolean().default(true))) }));
  assert.throws(() => mergeImpls(coreImpls, { bad: lane(withField(z.boolean().default(false))) }), /must be a boolean that defaults to true/);
  assert.throws(() => mergeImpls(coreImpls, { bad: lane(withField(z.boolean().optional())) }), /must be a boolean that defaults to true/);
  assert.throws(() => mergeImpls(coreImpls, { bad: lane(withField(z.boolean().default(true), "rehearse")) }), /has no such field/);
  // the core declarer: itch_push's dry_run passed the same check at load
  assert.equal(IMPLS.itch_push.itch_push.dryRunField, "dry_run");
});
