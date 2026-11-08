// T31: the "comfy" provider (local lab ComfyUI) against a fake ComfyUI HTTP server. No live lab calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodePng, encodePng, makeImage } from "./png.ts";
import { COMFY_DEFAULT_BASE_URL, COMFY_RECIPE, ChargedFailure, ProviderUnavailable, comfyBaseUrl, generate, quote } from "./generate.ts";
import { readProviders, readGallery, statePaths } from "./credits.ts";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";

interface Req { method: string; url: string; body: Buffer; json: any }
interface Lab { base: string; requests: Req[]; server: Server; close: () => Promise<void> }

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

/** A 768x768 opaque render: light background, a dark centered square (what snap + lock must reduce). */
function render(): Uint8Array {
  const img = makeImage(768, 768);
  for (let y = 0; y < 768; y++)
    for (let x = 0; x < 768; x++) {
      const inside = x >= 192 && x < 576 && y >= 192 && y < 576;
      img.data.set(inside ? [30, 20, 40, 255] : [240, 240, 235, 255], (y * 768 + x) * 4);
    }
  return encodePng(img);
}
const RENDER = render();

type Handler = (r: Req, res: ServerResponse, n: number) => void;

async function startLab(handle: Handler): Promise<Lab> {
  const requests: Req[] = [];
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let json: any = null;
      if ((req.headers["content-type"] ?? "").includes("application/json")) json = JSON.parse(body.toString("utf8"));
      const r: Req = { method: req.method ?? "", url: req.url ?? "", body, json };
      requests.push(r);
      const key = `${r.method} ${r.url.split("?")[0]}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      handle(r, res, n);
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const port = (server.address() as { port: number }).port;
  const close = () => {
    const p = Promise.withResolvers<void>();
    server.close(() => p.resolve());
    server.closeAllConnections();
    return p.promise;
  };
  return { base: `http://127.0.0.1:${port}`, requests, server, close };
}

/** The happy lab: ready, accepts the upload and the graph, history pending `pending` polls, then one image. */
function happyLab(opts: { pending?: number; history?: (n: number) => unknown } = {}): Handler {
  return (r, res, n) => {
    if (r.method === "GET" && r.url === "/system_stats") return send(res, 200, { system: { comfyui_version: "fake" }, devices: [] });
    if (r.method === "POST" && r.url === "/upload/image") {
      const name = /filename="([^"]+)"/.exec(r.body.toString("latin1"))?.[1] ?? "x.png";
      return send(res, 200, { name, subfolder: "", type: "input" });
    }
    if (r.method === "POST" && r.url === "/prompt") return send(res, 200, { prompt_id: "p-1", number: 1, node_errors: {} });
    if (r.method === "GET" && r.url === "/history/p-1") {
      if (opts.history) return send(res, 200, opts.history(n));
      if (n <= (opts.pending ?? 0)) return send(res, 200, {});
      return send(res, 200, { "p-1": { status: { status_str: "success", completed: true }, outputs: { "7": { images: [{ filename: "anyco_00001_.png", subfolder: "anyco", type: "output" }] } } } });
    }
    if (r.method === "GET" && r.url.startsWith("/view?")) {
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      return res.end(Buffer.from(RENDER));
    }
    return send(res, 404, {});
  };
}

function workspaceWithReference(): string {
  const ws = mkdtempSync(path.join(tmpdir(), "comfy-"));
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "hero-anchor.png"), encodePng(makeImage(16, 16)));
  return ws;
}
const FAST = { pollIntervalMs: 1, timeoutMs: 3000 };

test("T31 comfy: probe → upload → /prompt with the frozen recipe → poll /history → /view; written at cost 0 (local)", async () => {
  const lab = await startLab(happyLab({ pending: 2 }));
  try {
    const ws = workspaceWithReference();
    const r = await generate(
      { provider: "comfy", prompt: "a desert merchant", width: 32, height: 32, out: "game/assets/merchant.png", reference: "game/assets/hero-anchor.png", seed: 7 },
      { workspace: ws, baseUrl: { comfy: lab.base }, env: {}, ...FAST },
    );
    assert.deepEqual(r.images, ["game/assets/merchant.png"]);
    assert.deepEqual(Buffer.from(readFileSync(path.join(ws, "game/assets/merchant.png"))), Buffer.from(RENDER));
    assert.equal(r.cost_micro_usd, 0);
    assert.equal(r.cost_source, "local");
    assert.equal(r.metadata.method, "ipa");
    assert.equal(r.metadata.seed, 7);

    const order = lab.requests.map((q) => `${q.method} ${q.url.split("?")[0]}`);
    assert.deepEqual(order, ["GET /system_stats", "POST /upload/image", "POST /prompt", "GET /history/p-1", "GET /history/p-1", "GET /history/p-1", "GET /view"]);
    const upload = lab.requests[1].body.toString("latin1");
    assert.match(upload, /name="image"; filename="anyco-ref-[0-9a-f]{16}\.png"/);
    assert.ok(lab.requests[1].body.includes(Buffer.from(encodePng(makeImage(16, 16)))), "the reference PNG bytes are uploaded");

    const g = lab.requests[2].json.prompt;
    assert.equal(g["1"].inputs.ckpt_name, "NovaPixelILV3.safetensors");
    assert.equal(g["9"].inputs.ipadapter_file, "ip_adapter_Noobtest_800000.bin");
    assert.equal(g["10"].inputs.clip_name, COMFY_RECIPE.clip_vision);
    assert.equal(g["11"].inputs.weight, 0.65);
    assert.deepEqual(g["11"].inputs.image, ["8", 0]);
    assert.match(g["8"].inputs.image, /^anyco-ref-[0-9a-f]{16}\.png$/);
    assert.deepEqual(g["5"].inputs.model, ["11", 0], "the sampler runs the IP-Adapter model");
    assert.deepEqual([g["4"].inputs.width, g["4"].inputs.height], [768, 768]);
    const k = g["5"].inputs;
    assert.deepEqual([k.seed, k.steps, k.cfg, k.sampler_name, k.scheduler], [7, 30, 7, "euler_ancestral", "normal"]);
    assert.ok(!Object.values(g).some((n: any) => /ControlNet/.test(n.class_type)), "no pose ControlNet");
    assert.equal(g["2"].inputs.text, "a desert merchant");
    const view = new URL(lab.requests.at(-1)!.url, lab.base).searchParams;
    assert.deepEqual([view.get("filename"), view.get("subfolder"), view.get("type")], ["anyco_00001_.png", "anyco", "output"]);
  } finally {
    await lab.close();
  }
});

test("T31 comfy: without a reference the graph is text-only and the seed defaults to 42", async () => {
  const lab = await startLab(happyLab());
  try {
    const r = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: mkdtempSync(path.join(tmpdir(), "comfy-")), baseUrl: { comfy: lab.base }, env: {}, ...FAST });
    assert.equal(r.metadata.method, "text");
    const g = lab.requests.find((q) => q.url === "/prompt")!.json.prompt;
    assert.equal(g["5"].inputs.seed, 42);
    assert.deepEqual(g["5"].inputs.model, ["1", 0]);
    assert.equal(g["11"], undefined);
    assert.ok(!lab.requests.some((q) => q.url === "/upload/image"));
  } finally {
    await lab.close();
  }
});

test("T31 comfy: the production port 8188 is refused before any request, from options or COMFY_BASE_URL", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  const ws = mkdtempSync(path.join(tmpdir(), "comfy-"));
  for (const opts of [{ baseUrl: { comfy: "http://100.96.19.87:8188" }, env: {} }, { env: { COMFY_BASE_URL: "http://127.0.0.1:8188/" } }]) {
    const err = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: ws, fetchImpl, ...FAST, ...opts }).catch((e: unknown) => e);
    assert.ok(err instanceof Error && /refused: .*8188.*production ComfyUI/.test(err.message), String(err));
    assert.ok(!(err instanceof ProviderUnavailable), "a refused URL is a config error, not an outage to fall back from");
  }
  assert.equal(calls, 0);
  assert.equal(comfyBaseUrl({}, {}), COMFY_DEFAULT_BASE_URL);
  assert.equal(comfyBaseUrl({}, { COMFY_BASE_URL: "  " }), COMFY_DEFAULT_BASE_URL, "an empty env line is unset");
  assert.equal(comfyBaseUrl({}, { COMFY_BASE_URL: "http://lab.local:8190/" }), "http://lab.local:8190");
  assert.throws(() => comfyBaseUrl({}, { COMFY_BASE_URL: "file:///etc/passwd" }), /must be http/);
});

test("T31 comfy: a reference path escape is refused before any request (same rule as pixellab)", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  const ws = workspaceWithReference();
  const err = await generate(
    { provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png", reference: "../../etc/hosts" },
    { workspace: ws, fetchImpl, baseUrl: { comfy: "http://127.0.0.1:9" }, env: {}, ...FAST },
  ).catch((e: unknown) => e);
  assert.match(String(err), /path escapes the workspace/);
  assert.equal(calls, 0);
});

test("T31 comfy: a job that never finishes times out naming the prompt id; uncharged; frames and node_errors are refused", async () => {
  const lab = await startLab(happyLab({ history: () => ({}) }));
  try {
    const ws = mkdtempSync(path.join(tmpdir(), "comfy-"));
    const err = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: ws, baseUrl: { comfy: lab.base }, env: {}, pollIntervalMs: 5, timeoutMs: 150 }).catch((e: unknown) => e);
    assert.ok(err instanceof Error && /comfy generation timed out after 150 ms \(prompt p-1/.test(err.message), String(err));
    assert.ok(!(err instanceof ChargedFailure));
    assert.ok(!existsSync(path.join(ws, "a.png")));
    const anim = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png", frames: 4 }, { workspace: ws, baseUrl: { comfy: lab.base }, env: {}, ...FAST }).catch((e: unknown) => e);
    assert.match(String(anim), /stills only/);
  } finally {
    await lab.close();
  }
  const bad = await startLab((r, res) => (r.url === "/prompt" ? send(res, 400, { error: { type: "prompt_outputs_failed_validation" }, node_errors: { "1": { errors: [{ message: "Value not in list: ckpt_name" }] } } }) : happyLab()(r, res, 1)));
  try {
    const err = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: mkdtempSync(path.join(tmpdir(), "comfy-")), baseUrl: { comfy: bad.base }, env: {}, ...FAST }).catch((e: unknown) => e);
    assert.match(String(err), /comfy rejected the graph \(400\)/);
  } finally {
    await bad.close();
  }
});

test("T31 comfy: lab unreachable or unready is ProviderUnavailable (typed for fallback)", async () => {
  const closed = await startLab(happyLab());
  const deadBase = closed.base;
  await closed.close();
  const ws = mkdtempSync(path.join(tmpdir(), "comfy-"));
  const down = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: ws, baseUrl: { comfy: deadBase }, env: {}, ...FAST }).catch((e: unknown) => e);
  assert.ok(down instanceof ProviderUnavailable && down.provider === "comfy", String(down));
  const busy = await startLab((r, res) => send(res, 503, { error: "starting" }));
  try {
    const e = await generate({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png" }, { workspace: ws, baseUrl: { comfy: busy.base }, env: {}, ...FAST }).catch((x: unknown) => x);
    assert.ok(e instanceof ProviderUnavailable && /system_stats answered 503/.test(e.message), String(e));
    assert.equal(busy.requests.length, 1, "nothing is submitted to an unready lab");
  } finally {
    await busy.close();
  }
  const q = await quote({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "q.png" }, { workspace: ws });
  assert.deepEqual([q.per_call_usd, q.source], [0, "local"]);
});

// ---- capability: art_generate ----

const PALETTE = ["#1a1c2c", "#f4f4f4"];

function capabilityWorkspace(): { ws: string; ctx: ToolContext } {
  const ws = workspaceWithReference();
  writeFileSync(
    path.join(ws, "game", "assets", "manifest.json"),
    JSON.stringify({ schema_version: 1, style_bible: "docs/style-bible.md", grid: { w: 16, h: 16 }, palette: PALETTE, assets: [{ id: "merchant", type: "sprite", path: "assets/merchant.png", size: { w: 16, h: 16 }, palette: PALETTE, anchor: null }] }),
  );
  const runsDir = path.join(ws, "_runs");
  return { ws, ctx: { workspace: ws, naive: null, runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl"), run_id: "t31", agent: "art-director" } };
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const prev = { ...process.env };
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const PL_PNG = Buffer.from(encodePng(makeImage(16, 16))).toString("base64");
function fakePixellab(): Handler {
  return (r, res) => {
    if (r.method === "POST" && r.url === "/v2/generate-image-v2") return send(res, 202, { background_job_id: "pl-1", usage: { type: "usd", usd: 0.02 } });
    if (r.url === "/v2/background-jobs/pl-1") return send(res, 200, { status: "completed", usage: { type: "usd", usd: 0.02 }, last_response: { images: [{ type: "base64", base64: PL_PNG }] } });
    if (r.url === "/v2/balance") return send(res, 200, { credits: { usd: 0.9 } });
    return send(res, 404, {});
  };
}

test("T31 art_generate comfy: written and post-processed to the manifest grid and palette; cost 0, no credits line, counted toward the asset cap", async () => {
  const lab = await startLab(happyLab());
  const { ws, ctx } = capabilityWorkspace();
  try {
    await withEnv({ COMFY_BASE_URL: lab.base }, async () => {
      const r = await IMPLS.art_generate.art_generate.run(
        { provider: "comfy", prompt: "a merchant", width: 16, height: 16, out: "game/assets/merchant.png", reference: "game/assets/hero-anchor.png", postprocess: { snap: true, lock: true, outline: "#1a1c2c" } },
        ctx,
      );
      assert.equal(r.is_error, undefined, r.content);
      assert.equal(r.cost_micro_usd, 0);
      const out = JSON.parse(r.content);
      assert.equal(out.provider, "comfy");
      assert.equal(out.cost_source, "local");
      assert.equal(out.generation, "1 of 3");
      assert.equal(out.generations_used, undefined, "comfy does not count toward PixelLab generations");
      assert.ok(out.postprocess.snap && out.postprocess.lock, JSON.stringify(out.postprocess));
      const img = decodePng(new Uint8Array(readFileSync(path.join(ws, "game/assets/merchant.png"))));
      assert.deepEqual([img.width, img.height], [16, 16]);
      const colors = new Set<string>();
      for (let i = 0; i < img.data.length; i += 4)
        if (img.data[i + 3] !== 0) colors.add("#" + [0, 1, 2].map((j) => img.data[i + j].toString(16).padStart(2, "0")).join(""));
      assert.ok([...colors].every((c) => PALETTE.includes(c)), [...colors].join(","));
      assert.ok(!existsSync(statePaths(ctx.runsDir).credits), "no credits line for the local lab");
      assert.equal(readGallery(statePaths(ctx.runsDir).gallery).generations["assets/merchant.png"], 1);
    });
  } finally {
    await lab.close();
  }
});

test("T31 art_generate comfy: lab down → falls back to pixellab once, comfy is not marked exhausted, and the next call probes the lab again", async () => {
  const pl = await startLab(fakePixellab());
  const closed = await startLab(happyLab());
  const deadBase = closed.base;
  await closed.close();
  const { ctx } = capabilityWorkspace();
  try {
    await withEnv({ COMFY_BASE_URL: deadBase, PIXELLAB_API_KEY: "pl-t31", PIXELLAB_BASE_URL: pl.base }, async () => {
      const r = await IMPLS.art_generate.art_generate.run({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "game/assets/a.png" }, ctx);
      assert.equal(r.is_error, undefined, r.content);
      const out = JSON.parse(r.content);
      assert.equal(out.provider, "pixellab");
      assert.equal(out.fallback_from, "comfy");
      assert.match(out.notes.join(" "), /comfy is unavailable .*system_stats/);
      assert.match(out.notes.join(" "), /comfy is unavailable; tried pixellab once instead/);
      assert.equal(r.cost_micro_usd, 20_000);
      assert.equal(readProviders(statePaths(ctx.runsDir).providers).comfy, undefined, "a transient outage is never persisted");

      // the lab comes back: the next call uses it again
      const lab = await startLab(happyLab());
      try {
        process.env.COMFY_BASE_URL = lab.base;
        const r2 = await IMPLS.art_generate.art_generate.run({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "game/assets/b.png" }, ctx);
        assert.equal(JSON.parse(r2.content).provider, "comfy", r2.content);
        assert.equal(lab.requests[0].url, "/system_stats");
      } finally {
        await lab.close();
      }
    });
  } finally {
    await pl.close();
  }
});

test("T31 art_generate comfy: a refused 8188 URL is an error, not a fallback; the schema and description name comfy", async () => {
  const pl = await startLab(fakePixellab());
  const { ctx } = capabilityWorkspace();
  try {
    await withEnv({ COMFY_BASE_URL: "http://127.0.0.1:8188", PIXELLAB_API_KEY: "pl-t31", PIXELLAB_BASE_URL: pl.base }, async () => {
      const r = await IMPLS.art_generate.art_generate.run({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "game/assets/a.png" }, ctx);
      assert.equal(r.is_error, true);
      assert.match(r.content, /8188/);
      assert.equal(pl.requests.length, 0, "pixellab is not called to paper over a misconfigured lab URL");
    });
  } finally {
    await pl.close();
  }
  assert.doesNotThrow(() => IMPLS.art_generate.art_generate.input.parse({ provider: "comfy", prompt: "x", width: 16, height: 16, out: "a.png", negative: "blurry" }));
  assert.match(IMPLS.art_generate.art_generate.description, /comfy/);
});
