// T41b: several comfy lab lanes (COMFY_BASE_URLS) with least-queue routing and failover. Two fake ComfyUI servers; no live calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "./png.ts";
import { ProviderUnavailable, comfyLanes, generate } from "./generate.ts";
import { comfyLaneStats, readCredits, statePaths } from "./credits.ts";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";

const PNG = encodePng(makeImage(32, 32));
const FAST = { pollIntervalMs: 1, timeoutMs: 3000 };

interface Lane { base: string; urls: string[]; prompts: () => number; batches: number[]; close: () => Promise<void> }

/** A fake lab lane: `queue` jobs already waiting; `failPrompt` answers /prompt with a 500 (its call fails). */
async function lane(opts: { queue?: number; failPrompt?: boolean } = {}): Promise<Lane> {
  const urls: string[] = [];
  const batches: number[] = [];
  let batch = 1;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = req.url ?? "";
      urls.push(url.split("?")[0]);
      if (url === "/queue") return send(res, 200, { queue_running: Array.from({ length: Math.min(1, opts.queue ?? 0) }, () => [0]), queue_pending: Array.from({ length: Math.max(0, (opts.queue ?? 0) - 1) }, () => [0]) });
      if (url === "/upload/image") return send(res, 200, { name: "ref.png", subfolder: "" });
      if (url === "/prompt") {
        if (opts.failPrompt) return send(res, 500, { error: "CUDA out of memory" });
        batch = JSON.parse(data).prompt["4"].inputs.batch_size;
        batches.push(batch);
        return send(res, 200, { prompt_id: "p-1", node_errors: {} });
      }
      if (url === "/history/p-1") return send(res, 200, { "p-1": { status: { completed: true }, outputs: { "7": { images: Array.from({ length: batch }, (_, i) => ({ filename: `o${i}.png`, subfolder: "", type: "output" })) } } } });
      if (url.startsWith("/view?")) {
        res.setHeader("content-type", "image/png");
        return res.end(Buffer.from(PNG));
      }
      return send(res, 404, {});
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, urls, batches, prompts: () => urls.filter((u) => u === "/prompt").length, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
async function deadUrl(): Promise<string> {
  const l = await lane();
  await l.close();
  return l.base;
}

const gen = (env: Record<string, string>, extra: Record<string, unknown> = {}) =>
  generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "game/assets/a.png", maxCandidates: 4, ...extra }, { workspace: mkdtempSync(path.join(tmpdir(), "lanes-")), env, ...FAST });

test("T41b lanes: parsed from COMFY_BASE_URLS with per-lane max batch; :8188 refused in any entry; COMFY_BASE_URL stays the single fallback", async () => {
  assert.deepEqual(comfyLanes({}, { COMFY_BASE_URLS: "http://100.96.19.87:8191|4, http://100.96.19.87:8190|2" }), [
    { url: "http://100.96.19.87:8191", maxBatch: 4 },
    { url: "http://100.96.19.87:8190", maxBatch: 2 },
  ]);
  assert.deepEqual(comfyLanes({}, { COMFY_BASE_URLS: "http://a:1,http://b:2", COMFY_MAX_BATCH: "3" }).map((l) => l.maxBatch), [3, 3]);
  assert.deepEqual(comfyLanes({}, { COMFY_BASE_URL: "http://lab:8190/" }), [{ url: "http://lab:8190", maxBatch: 4 }]);
  assert.throws(() => comfyLanes({}, { COMFY_BASE_URLS: "http://100.96.19.87:8191|4,http://100.96.19.87:8188" }), /refused: .*8188.*production ComfyUI/);
  assert.throws(() => comfyLanes({}, { COMFY_BASE_URLS: "http://a:1|9" }), /COMFY_MAX_BATCH must be an integer from 1 to 8/);
  assert.throws(() => comfyLanes({}, { COMFY_BASE_URLS: "http://a:1,http://a:1" }), /twice/);
  assert.throws(() => comfyLanes({}, { COMFY_BASE_URLS: "http://a:1|2|3" }), /more than one "\|"/);
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new Error("no"); }) as unknown as typeof fetch;
  const err = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: mkdtempSync(path.join(tmpdir(), "lanes-")), fetchImpl, env: { COMFY_BASE_URLS: "http://127.0.0.1:9,http://127.0.0.1:8188" }, ...FAST }).catch((e: unknown) => e);
  assert.match(String(err), /8188/);
  assert.equal(calls, 0, "refused before any request");
});

test("T41b routing: the shortest queue wins; a tie goes to the lane listed first", async () => {
  const slow = await lane({ queue: 3 });
  const fast = await lane({ queue: 0 });
  try {
    const r = await gen({ COMFY_BASE_URLS: `${slow.base},${fast.base}` });
    assert.equal(r.metadata.lane, fast.base);
    assert.equal(r.metadata.lane_queue, 0);
    assert.deepEqual(r.metadata.lanes, [{ url: slow.base, queue: 3 }, { url: fast.base, queue: 0 }]);
    assert.deepEqual(slow.urls, ["/queue"], "the busy lane was only probed");
    assert.equal(fast.prompts(), 1);
  } finally {
    await slow.close();
    await fast.close();
  }
  const a = await lane();
  const b = await lane();
  try {
    assert.equal((await gen({ COMFY_BASE_URLS: `${b.base},${a.base}` })).metadata.lane, b.base, "tie → first listed");
  } finally {
    await a.close();
    await b.close();
  }
});

test("T41b failover: a lane that fails its probe, or its call, is skipped and the next lane serves", async () => {
  const dead = await deadUrl();
  const good = await lane({ queue: 2 });
  const oom = await lane({ queue: 0, failPrompt: true });
  try {
    const r1 = await gen({ COMFY_BASE_URLS: `${dead},${good.base}` });
    assert.equal(r1.metadata.lane, good.base);
    assert.match(JSON.stringify(r1.metadata.lanes), /queue: fetch failed|ECONNREFUSED/);
    const r2 = await gen({ COMFY_BASE_URLS: `${oom.base},${good.base}` });
    assert.equal(r2.metadata.lane, good.base, "the empty-queue lane failed its call; the next one served");
    assert.equal(oom.prompts(), 1);
    assert.match(JSON.stringify(r2.metadata.lanes_failed), /comfy rejected the graph \(500\)/);
  } finally {
    await good.close();
    await oom.close();
  }
});

test("T41b batch per lane: max_candidates clamps to the serving lane's max batch", async () => {
  const small = await lane({ queue: 0 });
  const big = await lane({ queue: 1 });
  try {
    const r = await gen({ COMFY_BASE_URLS: `${small.base}|1,${big.base}|4` });
    assert.deepEqual([r.metadata.lane, r.metadata.batch, r.images.length], [small.base, 1, 1]);
    const dead = await deadUrl();
    const r2 = await gen({ COMFY_BASE_URLS: `${dead}|1,${big.base}|4` });
    assert.deepEqual([r2.metadata.lane, r2.metadata.batch, r2.images.length], [big.base, 4, 4]);
    assert.deepEqual(big.batches, [4]);
  } finally {
    await small.close();
    await big.close();
  }
});

test("T41b all lanes down → ProviderUnavailable; with ART_DEFAULT_PROVIDER=comfy the call stops, no PixelLab request", async () => {
  const d1 = await deadUrl();
  const d2 = await deadUrl();
  const err = await gen({ COMFY_BASE_URLS: `${d1},${d2}` }).catch((e: unknown) => e);
  assert.ok(err instanceof ProviderUnavailable, String(err));
  assert.match((err as Error).message, /every lane is down: .*:\d+\/queue.*; .*:\d+\/queue/);

  let pixellab = 0;
  const pl = createServer((_req, res) => { pixellab++; res.statusCode = 500; res.end("{}"); });
  const { promise, resolve } = Promise.withResolvers<void>();
  pl.listen(0, "127.0.0.1", resolve);
  await promise;
  const ws = mkdtempSync(path.join(tmpdir(), "lanes-ws-"));
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "anchor.png"), PNG);
  const prev = { ...process.env };
  Object.assign(process.env, { COMFY_BASE_URLS: `${d1},${d2}`, ART_DEFAULT_PROVIDER: "comfy", PIXELLAB_API_KEY: "pl-x", PIXELLAB_BASE_URL: `http://127.0.0.1:${(pl.address() as { port: number }).port}` });
  try {
    const ctx: ToolContext = { workspace: ws, naive: null, runsDir: path.join(ws, "_runs"), ledgerFile: path.join(ws, "_runs", "l.jsonl"), run_id: "r", agent: "art-director" };
    const out = JSON.parse((await IMPLS.art_generate.art_generate.run({ prompt: "x", width: 16, height: 16, out: "game/assets/b.png", reference: "game/assets/anchor.png" }, ctx)).content);
    assert.equal(out.fallback, "procedural");
    assert.match(out.next, /^comfy default: lab unreachable/);
    assert.equal(pixellab, 0);
  } finally {
    for (const k of ["COMFY_BASE_URLS", "ART_DEFAULT_PROVIDER", "PIXELLAB_API_KEY", "PIXELLAB_BASE_URL"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await new Promise<void>((r) => pl.close(() => r()));
  }
});

test("T41b the serving lane is logged: result metadata, a local credits line, and per-lane stats in art_providers", async () => {
  const a = await lane({ queue: 1 });
  const b = await lane({ queue: 0 });
  const ws = mkdtempSync(path.join(tmpdir(), "lanes-ws-"));
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "anchor.png"), PNG);
  const ctx: ToolContext = { workspace: ws, naive: null, runsDir: path.join(ws, "_runs"), ledgerFile: path.join(ws, "_runs", "l.jsonl"), run_id: "r", agent: "art-director" };
  const prev = process.env.COMFY_BASE_URLS;
  process.env.COMFY_BASE_URLS = `${a.base}|4,${b.base}|2`;
  try {
    const r = await IMPLS.art_generate.art_generate.run({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "game/assets/c.png", reference: "game/assets/anchor.png" }, ctx);
    assert.equal(r.is_error, undefined, r.content);
    const out = JSON.parse(r.content);
    assert.equal(out.metadata.lane, b.base, "the tool result (and so the transcript's tool event) names the lane");
    const lines = readFileSync(statePaths(ctx.runsDir).credits, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.provider, l.unit, l.lane, l.images, l.batch]), [["comfy", "local", b.base, 2, 2]]);
    assert.deepEqual(readCredits(statePaths(ctx.runsDir).credits), [], "a local line is never read as a balance");
    assert.deepEqual(comfyLaneStats(statePaths(ctx.runsDir).credits), { [b.base]: { calls: 1, images: 2 } });
    const providers = JSON.parse((await IMPLS.art_generate.art_providers.run({}, ctx)).content);
    assert.deepEqual(providers.comfy_lanes, { [b.base]: { calls: 1, images: 2 } });
  } finally {
    if (prev === undefined) delete process.env.COMFY_BASE_URLS;
    else process.env.COMFY_BASE_URLS = prev;
    await a.close();
    await b.close();
  }
});
