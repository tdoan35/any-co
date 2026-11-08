// T44: the "openai" image provider against a fake OpenAI Image API. No live calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodePng, encodePng, makeImage } from "./png.ts";
import { OPENAI_IMAGE_ESTIMATE_USD, generate, openaiImageCost, openaiImageSize } from "./generate.ts";
import { markExhausted, openaiSpend, readCredits, readGallery, recordAnchorWinner, statePaths } from "./credits.ts";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";
import { read as readLedger } from "../ledger/ledger.ts";

const PNG = encodePng(makeImage(64, 64));
const REF = encodePng(makeImage(32, 32));
const USAGE = { input_tokens: 50, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens: 1056, total_tokens: 1106 };
const COST = (50 * 5 + 1056 * 30) / 1e6; // $0.03193 at the verified 2.6 prices

interface Req { url: string; headers: Record<string, string | string[] | undefined>; body: Buffer; json: any }
interface Fake { base: string; reqs: Req[]; close: () => Promise<void> }

/** A fake OpenAI Image API: answers n base64 PNGs with a usage object; `usage: false` omits it. */
async function fakeOpenAI(opts: { usage?: boolean; outTokens?: number } = {}): Promise<Fake> {
  const reqs: Req[] = [];
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (req.headers["content-type"] ?? "").includes("application/json") ? JSON.parse(body.toString("utf8")) : null;
      reqs.push({ url: req.url ?? "", headers: req.headers, body, json });
      const n = json ? json.n : Number(/name="n"\r\n\r\n(\d+)/.exec(body.toString("latin1"))?.[1] ?? "1");
      if (req.url === "/v1/images/generations" || req.url === "/v1/images/edits")
        return send(res, 200, { created: 1, data: Array.from({ length: n }, () => ({ b64_json: Buffer.from(PNG).toString("base64") })), ...(opts.usage === false ? {} : { usage: opts.outTokens ? { ...USAGE, output_tokens: opts.outTokens } : USAGE }) });
      return send(res, 404, {});
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { base, reqs, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function ctxFor(): ToolContext {
  const ws = mkdtempSync(path.join(tmpdir(), "openai-img-"));
  mkdirSync(path.join(ws, "game", "assets", "anchors"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "anchors", "hero.png"), REF);
  const runsDir = path.join(ws, "_runs");
  return { workspace: ws, naive: null, runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl"), run_id: "t44", agent: "art-director" };
}

const KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_IMAGE_MODEL", "OPENAI_IMAGE_CAP_USD", "ART_DEFAULT_PROVIDER", "PIXELLAB_API_KEY", "PIXELLAB_BASE_URL", "PIXELLAB_MIN_REMAINING", "COMFY_BASE_URL"];
async function withOpenAI<T>(f: Fake, env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-t44", OPENAI_BASE_URL: f.base, OPENAI_IMAGE_MODEL: "", OPENAI_IMAGE_CAP_USD: "", ART_DEFAULT_PROVIDER: "", PIXELLAB_MIN_REMAINING: "", ...env });
  try {
    return await fn();
  } finally {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}
const gen = (ctx: ToolContext, input: Record<string, unknown> = {}) =>
  IMPLS.art_generate.art_generate.run(IMPLS.art_generate.art_generate.input.parse({ provider: "openai", prompt: "a desert merchant", width: 32, height: 32, out: "game/assets/sprites/merchant.png", max_candidates: 1, ...input }), ctx);

test("T44 helpers: size by aspect, cost from usage at the verified 2.6 prices", () => {
  assert.equal(openaiImageSize(32, 32), "1024x1024");
  assert.equal(openaiImageSize(64, 32), "1536x1024");
  assert.equal(openaiImageSize(32, 64), "1024x1536");
  assert.ok(Math.abs(openaiImageCost("gpt-image-2.6-flare", USAGE)! - COST) < 1e-12);
  assert.equal(openaiImageCost("gpt-image-2.6-flare", null), null);
});

test("T44 generations: text-led JSON request (default flare, transparent png, medium, n, size), images written, cost from usage", async () => {
  const f = await fakeOpenAI();
  try {
    const ws = mkdtempSync(path.join(tmpdir(), "openai-gen-"));
    const r = await generate({ provider: "openai", prompt: "a desert merchant", width: 32, height: 32, out: "game/assets/a.png", maxCandidates: 3 }, { workspace: ws, baseUrl: { openai: f.base }, env: { OPENAI_API_KEY: "sk-test-t44" } });
    assert.equal(f.reqs.length, 1);
    const q = f.reqs[0];
    assert.equal(q.url, "/v1/images/generations");
    assert.equal(q.headers.authorization, "Bearer sk-test-t44");
    assert.deepEqual(
      [q.json.model, q.json.n, q.json.size, q.json.quality, q.json.background, q.json.output_format],
      ["gpt-image-2.6-flare", 3, "1024x1024", "medium", "transparent", "png"],
    );
    assert.deepEqual(r.images, ["game/assets/a-0.png", "game/assets/a-1.png", "game/assets/a-2.png"], "n>1 written as candidates");
    for (const img of r.images) assert.equal(decodePng(new Uint8Array(readFileSync(path.join(ws, img)))).width, 64);
    assert.equal(r.cost_source, "reported");
    assert.equal(r.cost_micro_usd, Math.round(COST * 1e6));
    assert.doesNotMatch(JSON.stringify(r), /sk-test-t44/, "the key never appears in the result");
  } finally {
    await f.close();
  }
});

test("T44 edits: reference-led multipart with the anchor as image[]; sunburst by param; no usage → conservative estimate", async () => {
  const f = await fakeOpenAI({ usage: false });
  try {
    const ws = mkdtempSync(path.join(tmpdir(), "openai-edit-"));
    mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
    writeFileSync(path.join(ws, "game", "assets", "hero.png"), REF);
    const r = await generate(
      { provider: "openai", prompt: "same character, waving", width: 32, height: 64, out: "game/assets/b.png", reference: "game/assets/hero.png", model: "gpt-image-2.6-sunburst", maxCandidates: 1 },
      { workspace: ws, baseUrl: { openai: f.base }, env: { OPENAI_API_KEY: "sk-test-t44" } },
    );
    const q = f.reqs[0];
    assert.equal(q.url, "/v1/images/edits");
    assert.match(String(q.headers["content-type"]), /^multipart\/form-data; boundary=/);
    const body = q.body.toString("latin1");
    assert.match(body, /name="image\[\]"; filename="reference.png"/);
    assert.ok(q.body.includes(Buffer.from(REF)), "the reference PNG bytes are sent");
    assert.match(body, /name="model"\r\n\r\ngpt-image-2.6-sunburst/);
    assert.match(body, /name="size"\r\n\r\n1024x1536/);
    assert.match(body, /name="background"\r\n\r\ntransparent/);
    assert.deepEqual(r.images, ["game/assets/b.png"]);
    assert.equal(r.cost_source, "estimated");
    assert.equal(r.cost_micro_usd, Math.round(OPENAI_IMAGE_ESTIMATE_USD * 1e6));
  } finally {
    await f.close();
  }
});

test("T44 refusals before any request: reference path escape, unknown model, frames", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new Error("must not be called"); }) as unknown as typeof fetch;
  const ws = mkdtempSync(path.join(tmpdir(), "openai-ref-"));
  const base = { prompt: "x", width: 32, height: 32, out: "game/assets/a.png" };
  const opts = { workspace: ws, fetchImpl, env: { OPENAI_API_KEY: "sk-test-t44" } };
  assert.match(String(await generate({ provider: "openai", ...base, reference: "../../etc/hosts" }, opts).catch((e: unknown) => e)), /path escapes the workspace/);
  assert.match(String(await generate({ provider: "openai", ...base, model: "dall-e-3" }, opts).catch((e: unknown) => e)), /openai image model must be one of gpt-image-2.6-flare, gpt-image-2.6-sunburst/);
  assert.match(String(await generate({ provider: "openai", ...base, frames: 4 }, opts).catch((e: unknown) => e)), /stills only/);
  assert.equal(calls, 0);
  assert.throws(() => IMPLS.art_generate.art_generate.input.parse({ provider: "openai", ...base, model: "dall-e-3" }), "the tool schema refuses an unknown model too");
});

test("T44 spend: recorded as a usd spend line (never read as a balance), charged to the run, and capped by OPENAI_IMAGE_CAP_USD", async () => {
  const f = await fakeOpenAI();
  try {
    const ctx = ctxFor();
    await withOpenAI(f, { OPENAI_IMAGE_CAP_USD: "0.3" }, async () => {
      const r = await gen(ctx, { max_candidates: 1 });
      assert.equal(r.is_error, undefined, r.content);
      assert.equal(r.cost_micro_usd, Math.round(COST * 1e6), "charged to the run budget");
      const out = JSON.parse(r.content);
      assert.deepEqual([out.provider, out.generation, out.generation_counter], ["openai", "1 of 3", "paid"]);
      const credits = statePaths(ctx.runsDir).credits;
      const lines = readFileSync(credits, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => [l.provider, l.unit, l.kind, l.images, l.model]), [["openai", "usd", "spend", 1, "gpt-image-2.6-flare"]]);
      assert.ok(Math.abs(openaiSpend(credits) - COST) < 1e-9);
      assert.deepEqual(readCredits(credits), [], "a spend line is never a balance");
      // the per-image estimate is now the measured ~$0.032; 4 images fit; then 8 images (~$0.26) would cross $0.30: refused
      assert.equal(JSON.parse((await gen(ctx, { out: "game/assets/sprites/b.png", max_candidates: 4 })).content).provider, "openai");
      const before = f.reqs.length;
      const refused = await gen(ctx, { out: "game/assets/sprites/c.png", max_candidates: 8 });
      assert.equal(refused.is_error, true);
      assert.match(refused.content, /OpenAI image spend cap: \$0\.06 of \$0\.30 spent \(OPENAI_IMAGE_CAP_USD\); this call \(8 image\(s\)\) could cost up to \$0\.26/);
      assert.equal(f.reqs.length, before, "no request past the cap");
      assert.equal(readLedger(ctx.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.openai_images").length, 1, "one note at the cap");
    });
  } finally {
    await f.close();
  }
});

test("T44 spend: one ledger note at 80% and one at the cap; a malformed cap is an error", async () => {
  // 7,000 output tokens = $0.21 + text: the first call fits a $0.26 cap (estimate $0.25), lands at ~81%, the next can't fit
  const f = await fakeOpenAI({ outTokens: 7000 });
  try {
    const ctx = ctxFor();
    await withOpenAI(f, { OPENAI_IMAGE_CAP_USD: "0.26" }, async () => {
      assert.equal((await gen(ctx)).is_error, undefined); // ~81% of the cap
      await gen(ctx, { out: "game/assets/sprites/x.png" }).catch(() => undefined); // would cross: refused, cap note
      const notes = readLedger(ctx.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.openai_images").map((e) => (e as { refs?: string[] }).refs![0]);
      assert.deepEqual(notes, ["openai-image-spend:80", "openai-image-spend:cap"]);
      await gen(ctx, { out: "game/assets/sprites/y.png" });
      assert.equal(readLedger(ctx.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.openai_images").length, 2, "no duplicates");
    });
    await withOpenAI(f, { OPENAI_IMAGE_CAP_USD: "lots" }, async () => {
      const r = await gen(ctxFor());
      assert.match(r.content, /OPENAI_IMAGE_CAP_USD must be a non-negative number/);
    });
  } finally {
    await f.close();
  }
});

test("T44 explicit only: never a default, an anchor winner, or a fallback", async () => {
  const f = await fakeOpenAI();
  try {
    await withOpenAI(f, {}, async () => {
      // an anchor winner of openai does not make omitted-provider calls use it
      const ctx = ctxFor();
      recordAnchorWinner(statePaths(ctx.runsDir).gallery, "game/assets/anchors/hero.png", "openai", "r", "bake-off");
      const r = await IMPLS.art_generate.art_generate.run(IMPLS.art_generate.art_generate.input.parse({ prompt: "x", width: 32, height: 32, out: "game/assets/sprites/a.png", reference: "game/assets/anchors/hero.png" }), ctx);
      assert.match(r.content, /OpenAI images run only when the call names provider "openai" explicitly/);
      // pixellab and retrodiffusion both exhausted: the chain ends procedural, it never reaches openai
      const ctx2 = ctxFor();
      for (const p of ["pixellab", "retrodiffusion"] as const) markExhausted(statePaths(ctx2.runsDir).providers, p, { reason: "test" });
      const r2 = JSON.parse((await IMPLS.art_generate.art_generate.run(IMPLS.art_generate.art_generate.input.parse({ provider: "pixellab", prompt: "x", width: 32, height: 32, out: "game/assets/sprites/b.png" }), ctx2)).content);
      assert.equal(r2.fallback, "procedural");
      assert.equal(f.reqs.length, 0, "openai was never called");
    });
    await withOpenAI(f, { ART_DEFAULT_PROVIDER: "openai" }, async () => {
      const r = await IMPLS.art_generate.art_generate.run(IMPLS.art_generate.art_generate.input.parse({ prompt: "x", width: 32, height: 32, out: "game/assets/sprites/c.png", reference: "game/assets/anchors/hero.png" }), ctxFor());
      assert.match(r.content, /ART_DEFAULT_PROVIDER must be one of comfy, pixellab, retrodiffusion/, "openai can't be the studio default");
      assert.equal(f.reqs.length, 0);
    });
  } finally {
    await f.close();
  }
});

test("T44 counts against the PAID regen cap (1 + 2), shared with pixellab, not comfy's", async () => {
  const f = await fakeOpenAI();
  try {
    const ctx = ctxFor();
    await withOpenAI(f, {}, async () => {
      for (let n = 1; n <= 3; n++) assert.equal(JSON.parse((await gen(ctx)).content).generation, `${n} of 3`);
      const refused = await gen(ctx);
      assert.match(refused.content, /has had 3 paid generations \(1 \+ 2 regenerations is the paid cap\)/);
      assert.equal(f.reqs.length, 3, "the 4th call made no request");
      const g = readGallery(statePaths(ctx.runsDir).gallery);
      assert.deepEqual([g.generations["assets/sprites/merchant.png"], g.comfy_generations?.["assets/sprites/merchant.png"]], [3, undefined]);
    });
  } finally {
    await f.close();
  }
});
