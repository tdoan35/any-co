// T50: Monid tools against a fake Monid HTTP server (never the real API). Shapes follow docs.monid.ai and @monid-ai/cli 0.1.9.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONID_POLL, clearMonidCache, monidSpentTodayUsd, monidTools, parseToolId, priceEstimateUsd, redact, reportedCostUsd } from "./monid.ts";
import type { ToolContext } from "./kit.ts";
import { SpendLedger } from "../spend.ts";
import { read as readLedger } from "../../tools/ledger/ledger.ts";
import { loadAgent } from "../load.ts";
import { FakeProvider } from "../providers.ts";
import { runAgent } from "../run.ts";
import type { ToolUseBlock } from "../types.ts";

const KEY = "monid_test_S3CRETkey0123456789";
const SPEC_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec.ts");

interface Seen { method: string; url: string; auth: string | undefined; body: any }
let server: Server;
let base = "";
let seen: Seen[] = [];
const files = new Map<string, Buffer>();
const asyncRuns = new Map<string, number>(); // runId → GETs left before COMPLETED

const PRICES: Record<string, unknown> = {
  "/cheap": { type: "PER_CALL", amount: 0.5, currency: "USD" },
  "/pricey": { type: "PER_CALL", amount: 4, currency: "USD" },
  "/async": { type: "PER_CALL", amount: 1, currency: "USD" },
  "/varies": { type: "PER_UNIT_MATRIX", variants: [{ when: { duration: "5" }, price: { amount: 0.2, per: { unit: "SECOND", count: 1 } } }] },
};
const body = (req: IncomingMessage) => new Promise<Buffer>((res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await body(req);
    let json: any = null;
    try { json = raw.length ? JSON.parse(raw.toString()) : null; } catch {}
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: json });
    const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== undefined && req.headers.authorization !== `Bearer ${KEY}` && req.url!.startsWith("/v1/"))
      return send(401, { error: { code: "AUTH_FAILED", message: `invalid key ${req.headers.authorization.slice(7)}` } });
    if (req.method === "PUT" && req.url!.startsWith("/upload/")) { files.set(req.url!.slice(8), raw); res.writeHead(200); return res.end(); }
    if (req.method === "GET" && req.url!.startsWith("/files/")) {
      const f = files.get(req.url!.slice(7)) ?? Buffer.from("fake-mp4-bytes");
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(f.length) });
      return res.end(f);
    }
    if (req.url === "/v1/discover") return send(200, { results: [{ provider: "acme", providerName: "Acme Video", endpoint: "/cheap", description: "Image to video", price: PRICES["/cheap"] }, { provider: "acme", providerName: "Acme Video", endpoint: "/varies", description: "Per-second video", price: PRICES["/varies"] }], query: json.query, count: 2 });
    if (req.url === "/v1/inspect") {
      if (!(json.endpoint in PRICES)) return send(404, { error: { message: "no such endpoint" } });
      return send(200, { provider: json.provider, providerName: "Acme Video", endpoint: json.endpoint, description: "d", price: PRICES[json.endpoint], input: { body: { prompt: "string", imageUrl: "url" } } });
    }
    if (req.url === "/v1/run") {
      const id = `run-${seen.length}`;
      if (json.provider === "sfs" && json.endpoint === "/put") return send(200, { runId: id, provider: "sfs", endpoint: "/put", status: "COMPLETED", output: { uploadUrl: `${base}/upload/${encodeURIComponent(json.input.body.path)}` } });
      if (json.provider === "sfs" && json.endpoint === "/cat") return send(200, { runId: id, provider: "sfs", endpoint: "/cat", status: "COMPLETED", output: { url: `${base}/files/${encodeURIComponent(json.input.body.path)}`, expiresAt: "2026-11-09T00:00:00Z" } });
      if (json.endpoint === "/leaky") return send(500, { error: { message: `upstream rejected Bearer ${KEY} for ${KEY}` } });
      if (json.endpoint === "/async") { asyncRuns.set(id, 1); return send(202, { runId: id, provider: "acme", endpoint: "/async", status: "RUNNING", price: PRICES["/async"] }); }
      return send(200, { runId: id, provider: "acme", endpoint: json.endpoint, status: "COMPLETED", output: { videoUrl: `${base}/files/out.mp4` }, providerResponse: { httpStatus: 200 },
        billing: { calculatedCost: { value: 500000, unit: "MICRO_DOLLAR", currency: "USD" }, reportedCost: { value: 420000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    }
    const m = /^\/v1\/runs\/([^/]+)$/.exec(req.url!);
    if (m) {
      const left = asyncRuns.get(m[1]);
      if (left === undefined) return send(404, { error: { message: "run not found" } });
      if (left > 0) { asyncRuns.set(m[1], left - 1); return send(200, { runId: m[1], provider: "acme", endpoint: "/async", status: "RUNNING" }); }
      return send(200, { runId: m[1], provider: "acme", endpoint: "/async", status: "COMPLETED", output: { videoUrl: `${base}/files/out.mp4` }, cost: { value: 0.8, currency: "USD" } });
    }
    send(404, { error: { message: "unknown route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const ENV_KEYS = ["MONID_API_KEY", "MONID_API_BASE_URL", "MONID_CAP_USD", "MONID_APPROVAL_USD"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });
beforeEach(() => {
  seen = [];
  clearMonidCache();
  process.env.MONID_API_KEY = KEY;
  process.env.MONID_API_BASE_URL = base;
  delete process.env.MONID_CAP_USD;
  delete process.env.MONID_APPROVAL_USD;
  MONID_POLL.firstMs = 5;
  MONID_POLL.maxMs = 10;
});

function ctx(): ToolContext {
  const runsDir = mkdtempSync(path.join(tmpdir(), "monid-runs-"));
  const workspace = path.join(runsDir, "r1", "workspace");
  mkdirSync(workspace, { recursive: true });
  return { workspace, naive: null, agent: "short-form-video-producer", run_id: "r1", runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl") };
}
const call = async (tool: string, input: Record<string, unknown>, c: ToolContext) => monidTools[tool].run(monidTools[tool].input.parse(input), c);
const seedSpend = (c: ToolContext, usd: number) =>
  new SpendLedger(path.join(c.runsDir!, "spend.jsonl")).append({ ts: new Date().toISOString(), run_id: "earlier", agent: "x", kind: "tool", what: "monid_run", micro_usd: Math.round(usd * 1e6) });
const v1 = () => seen.filter((s) => s.url.startsWith("/v1/"));

test("T50: pure helpers: tool ids, fixed-price estimates, reported costs, redaction", () => {
  assert.deepEqual(parseToolId("apify/apidojo/tweet-scraper"), { provider: "apify", endpoint: "/apidojo/tweet-scraper" });
  assert.equal(parseToolId("no-endpoint"), null);
  assert.equal(priceEstimateUsd({ type: "PER_CALL", amount: 0.003 }), 0.003);
  assert.equal(priceEstimateUsd({ type: "PER_RESULT", amount: 0.001, flatFee: 0.002 }), null, "per result depends on the output");
  assert.equal(priceEstimateUsd(PRICES["/varies"]), null, "per second depends on the input");
  // the live discover shape (Nov 8 smoke): TIERED, $0 amount, per-second tiers → not boundable, max_usd is the estimate
  assert.equal(priceEstimateUsd({ type: "TIERED", amount: { value: 0, currency: "USD" }, tiers: [{ label: "480p", when: { resolution: "480p" }, price: { type: "PER_UNIT", amount: { value: 0.01, currency: "USD" }, per: 1, unit: "second" } }] }), null);
  assert.deepEqual(parseToolId("heygen/promo/v1/video/heygen-video-1-i2v"), { provider: "heygen", endpoint: "/promo/v1/video/heygen-video-1-i2v" });
  assert.equal(priceEstimateUsd({ type: "TIERED", default: { type: "PER_CALL", amount: 0.1 }, tiers: [{ label: "hd", price: 0.2 }] }), 0.30000000000000004);
  assert.equal(reportedCostUsd({ billing: { reportedCost: { value: 3000, unit: "MICRO_DOLLAR", currency: "USD" } } }), 0.003);
  assert.equal(reportedCostUsd({ cost: { value: 0.8, currency: "USD" } }), 0.8);
  assert.equal(reportedCostUsd({ cost: { value: 5, currency: "EUR" } }), null, "unknown units are not guessed");
  process.env.MONID_API_KEY = KEY;
  assert.equal(redact(`x ${KEY} y Bearer abcdefghij monid_live_zzzzzzzz`), "x [redacted] y Bearer [redacted] [redacted]");
});

test("T50: discover and inspect: shapes, Bearer auth, key never in results", async () => {
  const c = ctx();
  const d = await call("monid_discover", { query: "image to video" }, c);
  assert.equal(d.is_error, undefined, d.content);
  const dj = JSON.parse(d.content);
  assert.deepEqual(dj.results.map((r: any) => [r.tool_id, r.estimate_usd]), [["acme/cheap", 0.5], ["acme/varies", null]]);
  const i = await call("monid_inspect", { tool_id: "acme/cheap" }, c);
  const ij = JSON.parse(i.content);
  assert.equal(ij.estimate_usd, 0.5);
  assert.deepEqual(ij.input, { body: { prompt: "string", imageUrl: "url" } });
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.body]), [["POST", "/v1/discover", { query: "image to video", limit: 8 }], ["POST", "/v1/inspect", { provider: "acme", endpoint: "/cheap" }]]);
  assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
  for (const out of [d, i]) assert.ok(!out.content.includes(KEY));
});

test("T50: no key, or a key the server echoes back in an error: refused / redacted, never leaked", async () => {
  const c = ctx();
  delete process.env.MONID_API_KEY;
  for (const t of ["monid_discover", "monid_inspect", "monid_run", "monid_run_get", "monid_upload"] as const) {
    const input = { monid_discover: { query: "x" }, monid_inspect: { tool_id: "acme/cheap" }, monid_run: { tool_id: "acme/cheap", max_usd: 1 }, monid_run_get: { run_id: "r" }, monid_upload: { path: "a.mp4" } }[t];
    const r = await call(t, input, c);
    assert.equal(r.is_error, true);
    assert.match(r.content, /MONID_API_KEY is not set.*no request was made/);
  }
  assert.equal(seen.length, 0);
  process.env.MONID_API_KEY = KEY;
  const r = await call("monid_run", { tool_id: "acme/leaky", max_usd: 1 }, c);
  assert.equal(r.is_error, true);
  assert.match(r.content, /failed \(500\)/);
  assert.ok(!r.content.includes(KEY), r.content);
  assert.match(r.content, /\[redacted\]/);
  // a wrong key echoed in a 401 is redacted too (it is shaped like a Monid key)
  process.env.MONID_API_KEY = "monid_test_WRONGkey987654";
  const bad = await call("monid_discover", { query: "x" }, c);
  assert.match(bad.content, /401, key refused/);
  assert.ok(!bad.content.includes("WRONGkey987654"), bad.content);
});

test("T50: a sync run is charged its reported cost (billing.reportedCost, micro-dollars) once", async () => {
  const c = ctx();
  const r = await call("monid_run", { tool_id: "acme/cheap", inputs: { prompt: "p" }, max_usd: 1 }, c);
  assert.equal(r.is_error, undefined, r.content);
  const j = JSON.parse(r.content);
  assert.equal(j.status, "COMPLETED");
  assert.equal(j.cost_usd, 0.42);
  assert.equal(j.charged_usd, 0.42);
  assert.equal(j.estimate_from, "price");
  assert.deepEqual(j.output, { videoUrl: `${base}/files/out.mp4` });
  assert.equal(r.cost_micro_usd, 420000);
  assert.deepEqual(v1().map((s) => s.url), ["/v1/inspect", "/v1/run"]);
  assert.deepEqual(seen[1].body, { provider: "acme", endpoint: "/cheap", input: { body: { prompt: "p" } } });
});

test("T50: an async run reserves its estimate, then run_get settles upward only, never twice", async () => {
  const c = ctx();
  const r = await call("monid_run", { tool_id: "acme/async", max_usd: 2, wait_s: 0 }, c);
  const j = JSON.parse(r.content);
  assert.equal(j.status, "RUNNING");
  assert.equal(r.cost_micro_usd, 1_000_000, "the fixed price is reserved while it runs");
  // the runner charges the result: simulate its spend line so the day total sees it
  new SpendLedger(path.join(c.runsDir!, "spend.jsonl")).append({ ts: new Date().toISOString(), run_id: "r1", agent: "a", kind: "tool", what: "monid_run", micro_usd: r.cost_micro_usd! });
  const g = await call("monid_run_get", { run_id: j.monid_run_id, wait_s: 5 }, c);
  const gj = JSON.parse(g.content);
  assert.equal(gj.status, "COMPLETED");
  assert.equal(gj.cost_usd, 0.8);
  assert.equal(g.cost_micro_usd, 0, "reported $0.80 is under the $1 reserved: nothing more, no refund");
  assert.equal(gj.charged_usd, 1);
  assert.equal(gj.tracked, true);
  const again = await call("monid_run_get", { run_id: j.monid_run_id }, c);
  assert.equal(again.cost_micro_usd, 0);
  const state = JSON.parse(readFileSync(path.join(c.runsDir!, "monid-runs.json"), "utf8"));
  assert.equal(state.runs[j.monid_run_id].status, "COMPLETED");
});

test("T50: at the day cap a run is refused with ZERO requests, and the cap decision is ledgered once", async () => {
  const c = ctx();
  seedSpend(c, 25);
  for (let n = 0; n < 2; n++) {
    const r = await call("monid_run", { tool_id: "acme/cheap", max_usd: 1 }, c);
    assert.equal(r.is_error, true);
    assert.match(r.content, /at MONID_CAP_USD \$25\.00 \(no request was made\)/);
  }
  assert.equal(seen.length, 0);
  assert.equal(await monidTools.monid_run.approvalWhen!({ tool_id: "acme/pricey", max_usd: 5 }, c), null, "no approval wait for a run that will be refused");
  assert.equal(seen.length, 0);
  const caps = readLedger(c.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.monid");
  assert.equal(caps.length, 1);
  assert.match(String((caps[0] as { decision?: string }).decision), /at today's cap/);
});

test("T50: spent + estimate over the cap, or a fixed price over max_usd: refused before any paid run", async () => {
  const c = ctx();
  process.env.MONID_CAP_USD = "10";
  seedSpend(c, 9.8);
  const r = await call("monid_run", { tool_id: "acme/cheap", max_usd: 1 }, c);
  assert.match(r.content, /\$9\.80 spent today \+ this run's estimate \$0\.50 is over MONID_CAP_USD \$10\.00 \(no run was made\)/);
  const p = await call("monid_run", { tool_id: "acme/pricey", max_usd: 1 }, ctx());
  assert.match(p.content, /costs \$4\.0000 per call, over your max_usd \$1 \(no run was made\)/);
  assert.ok(!seen.some((s) => s.url === "/v1/run"), "only free inspect calls were made");
  // a varying price uses max_usd as the estimate
  const v = await call("monid_run", { tool_id: "acme/varies", max_usd: 0.3 }, c);
  assert.match(v.content, /estimate \$0\.30 is over/);
});

test("T50: 80% of the cap is ledgered once per day", async () => {
  const c = ctx();
  process.env.MONID_CAP_USD = "1";
  seedSpend(c, 0.4);
  const r = await call("monid_run", { tool_id: "acme/cheap", max_usd: 1 }, c);
  assert.equal(JSON.parse(r.content).cap_note, "past 80% of today's cap");
  const notes = readLedger(c.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.monid");
  assert.equal(notes.length, 1);
  assert.match(String((notes[0] as { decision?: string }).decision), /passed 80%.*\$0\.82 of \$1\.00/);
});

test("T50: upload: workspace media only (escape, symlink, non-media, secrets refused with zero requests); signed PUT carries no key", async () => {
  const c = ctx();
  const outside = mkdtempSync(path.join(tmpdir(), "monid-outside-"));
  writeFileSync(path.join(outside, "x.mp4"), "secret-ish");
  mkdirSync(path.join(c.workspace, "media"), { recursive: true });
  symlinkSync(path.join(outside, "x.mp4"), path.join(c.workspace, "media", "link.mp4"));
  writeFileSync(path.join(c.workspace, "notes.md"), "n");
  writeFileSync(path.join(c.workspace, "media", "clip.mp4"), "fake-mp4-bytes-1234");
  for (const [p, re] of [["../x.mp4", /escapes the workspace/], ["media/link.mp4", /through a symlink/], ["notes.md", /only media files/], [".env.mp4", /looks like a secret/], ["media/none.mp4", /not a file/]] as const) {
    const r = await call("monid_upload", { path: p }, c);
    assert.equal(r.is_error, true, p);
    assert.match(r.content, re);
  }
  assert.equal(seen.length, 0);
  const up = await call("monid_upload", { path: "media/clip.mp4" }, c);
  assert.equal(up.is_error, undefined, up.content);
  const uj = JSON.parse(up.content);
  assert.match(uj.url, /\/files\/any-co%2Fr1%2F[0-9a-f]{12}-clip\.mp4$/);
  assert.equal(uj.bytes, 19);
  const put = seen.find((s) => s.method === "PUT")!;
  assert.equal(put.auth, undefined, "the key never goes to a signed URL");
  assert.deepEqual(seen.filter((s) => s.url === "/v1/run").map((s) => [s.body.provider, s.body.endpoint, s.body.input.body.ttl ?? s.body.input.body.sizeBytes]), [["sfs", "/put", 19], ["sfs", "/cat", "1d"]]);
  // round trip: download it back into media/
  const dl = await call("monid_download", { url: uj.url, out: "media/monid/back.mp4" }, c);
  assert.equal(dl.is_error, undefined, dl.content);
  assert.equal(readFileSync(path.join(c.workspace, "media", "monid", "back.mp4"), "utf8"), "fake-mp4-bytes-1234");
  assert.equal(seen.at(-1)!.auth, undefined);
  // private hosts and non-media outputs are refused before any request
  const n = seen.length;
  assert.match((await call("monid_download", { url: "http://10.0.0.5/a.mp4", out: "media/a.mp4" }, c)).content, /not a public https host/);
  assert.match((await call("monid_download", { url: "https://cdn.example.com/a.mp4", out: "../a.mp4" }, c)).content, /escapes the workspace/);
  assert.match((await call("monid_download", { url: "https://cdn.example.com/a.sh", out: "media/a.sh" }, c)).content, /only media files/);
  assert.equal(seen.length, n);
  assert.equal(existsSync(path.join(c.workspace, "..", "a.mp4")), false);
});

// ---------- through the runner: approval threshold on an allow grant, spend line + run charge ----------
async function monidAgent() {
  const agents = mkdtempSync(path.join(tmpdir(), "anyco-agents-"));
  mkdirSync(path.join(agents, "monid-agent"));
  writeFileSync(path.join(agents, "monid-agent", "spec.ts"), `import { defineAgent } from ${JSON.stringify(SPEC_TS)};
export default defineAgent({ name: "monid-agent", description: "Fixture: Monid tools on an allow grant.", dept: "test", runner: "local",
  model: "z-ai/glm-5.3-flash", budget: { cap_usd: 50, max_task_usd: 20, period: "day" }, tools: { monid: "allow" } });\n`);
  writeFileSync(path.join(agents, "monid-agent", "system.md"), "You are a fixture agent used only by tests of the Monid tools. Answer briefly.");
  return loadAgent("monid-agent", agents);
}
const use = (name: string, input: Record<string, unknown>, id: string): ToolUseBlock => ({ type: "tool_use", id, name, input });

test("T50 runner: a cheap run is ungated and charged to spend.jsonl + the run; one over MONID_APPROVAL_USD waits for approval", async () => {
  const spec = await monidAgent();
  const runsDir = mkdtempSync(path.join(tmpdir(), "monid-runner-"));
  const asked: any[] = [];
  const fake = new FakeProvider([
    { content: [use("monid_run", { tool_id: "acme/cheap", max_usd: 1 }, "a")] },
    { content: [use("monid_run", { tool_id: "acme/pricey", max_usd: 5 }, "b")] },
    { content: [{ type: "text", text: "done" }] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir, approver: async (req) => (asked.push(req), false) });
  assert.equal(r.status, "done");
  assert.equal(asked.length, 1, "only the $4 run asked");
  assert.equal(asked[0].tool, "monid_run");
  assert.match(asked[0].input.approval_reason, /estimated \$4\.00 \(fixed price\) is over MONID_APPROVAL_USD \$3\.00/);
  assert.match(JSON.stringify(fake.requests[2].messages.at(-1)), /a human declined this action/);
  assert.equal(seen.filter((s) => s.url === "/v1/run").length, 1, "the declined run never reached Monid");
  const lines = new SpendLedger(path.join(runsDir, "spend.jsonl")).entries().filter((e) => e.what === "monid_run");
  assert.deepEqual(lines.map((e) => [e.kind, e.micro_usd, e.run_id]), [["tool", 420000, r.run_id]]);
  assert.ok(r.spent_micro_usd >= 420000, "the run budget carries the Monid cost");
  assert.equal(monidSpentTodayUsd(runsDir), 0.42);
  // the model is told up front which calls ask
  const def = fake.requests[0].tools.find((t) => t.name === "monid_run")!;
  assert.match(def.description, /MONID_APPROVAL_USD waits for human approval/);
});
