import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodePng, encodePng, makeImage } from "./png.ts";
import { ChargedFailure, generate, resolveInside } from "./generate.ts";

const PNG_BYTES = encodePng(makeImage(2, 2));
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}

interface Harness {
  baseUrl: string;
  requests: CapturedRequest[];
  server: Server;
}

/** Fake provider server. The handler owns the response; call counts are per URL. */
async function startServer(
  handle: (req: CapturedRequest, count: number, res: ServerResponse) => void,
): Promise<Harness> {
  const requests: CapturedRequest[] = [];
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const n = (counts.get(`${req.method} ${url}`) ?? 0) + 1;
      counts.set(`${req.method} ${url}`, n);
      const captured: CapturedRequest = { method: req.method ?? "", url, headers: req.headers, body: data ? JSON.parse(data) : null };
      requests.push(captured);
      handle(captured, n, res);
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server has no address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
const raw = (res: ServerResponse, status: number, bytes: Uint8Array, type = "image/png") => {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.end(Buffer.from(bytes));
};

function tempWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "artgen-"));
}

const FAST = { pollIntervalMs: 1, timeoutMs: 2000 };
const ENV = { PIXELLAB_API_KEY: "pl-test-token", RETRO_DIFFUSION_API_KEY: "rdpk-test" };

async function withServer(handle: Parameters<typeof startServer>[0], fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await startServer(handle);
  try {
    await fn(h);
  } finally {
    const { promise, resolve } = Promise.withResolvers<void>();
    h.server.close(() => resolve());
    await promise;
  }
}

// ---- Retro Diffusion ----

test("retrodiffusion success: auth, body shape, written PNG, reported cost", async () => {
  const ws = tempWorkspace();
  writeFileSync(path.join(ws, "anchor.png"), PNG_BYTES);
  await withServer(
    (req, count, res) => {
      if (req.method === "POST" && req.url === "/v2/inferences") json(res, 202, { status: "accepted", task_id: "t-1", request_id: "req-1" });
      else if (req.url === "/v2/inferences/tasks/t-1")
        json(res, 200, count === 1 ? { status: "running" } : { status: "succeeded", result: { base64_images: [PNG_B64], balance_cost: 0.019, remaining_balance: 10.5, model: "rd_pro", request_id: "req-1" } });
      else json(res, 404, { error: { code: "not_found", message: "nope" } });
    },
    async ({ baseUrl, requests }) => {
      const result = await generate(
        { provider: "retrodiffusion", prompt: "a sprite", width: 64, height: 64, out: "gen/sprite.png", reference: "anchor.png", seed: 7 },
        { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST },
      );
      assert.deepEqual(result.images, ["gen/sprite.png"]);
      assert.equal(result.cost_micro_usd, 19_000);
      assert.equal(result.cost_source, "reported");
      assert.equal((result.metadata as { task_id: string }).task_id, "t-1");

      const post = requests.find((r) => r.method === "POST")!;
      assert.equal(post.headers["x-rd-token"], "rdpk-test");
      assert.ok(post.headers["idempotency-key"]);
      assert.equal(post.body.prompt, "a sprite");
      assert.equal(post.body.prompt_style, "rd_pro__default");
      assert.equal(post.body.width, 64);
      assert.equal(post.body.height, 64);
      assert.equal(post.body.num_images, 1);
      assert.equal(post.body.seed, 7);
      assert.equal(post.body.remove_bg, true);
      assert.deepEqual(post.body.reference_images, [PNG_B64]);
      assert.equal(post.body.input_image, undefined);

      const written = decodePng(new Uint8Array(readFileSync(path.join(ws, "gen/sprite.png"))));
      assert.equal(written.width, 2);
      assert.ok(!JSON.stringify(result.metadata).includes("rdpk")); // metadata never carries auth material
    },
  );
});

test("retrodiffusion downloads hosted output_urls when base64 is empty; multiple images get -N names", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST" && req.url === "/v2/inferences") json(res, 202, { status: "accepted", task_id: "t-2" });
      else if (req.url === "/v2/inferences/tasks/t-2")
        json(res, 200, { status: "succeeded", result: { base64_images: [], output_urls: [`http://${req.headers.host}/files/a.png`, `http://${req.headers.host}/files/b.png`], balance_cost: 0.036 } });
      else if (req.url === "/files/a.png" || req.url === "/files/b.png") raw(res, 200, PNG_BYTES);
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      const result = await generate(
        { provider: "retrodiffusion", prompt: "two takes", width: 64, height: 64, out: "gen/take.png" },
        { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST },
      );
      assert.deepEqual(result.images, ["gen/take-0.png", "gen/take-1.png"]);
      assert.equal(result.cost_micro_usd, 36_000);
    },
  );
});

test("retrodiffusion cost falls back to the documented table and is marked estimated", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "t-3" });
      else if (req.url === "/v2/inferences/tasks/t-3") json(res, 200, { status: "succeeded", result: { base64_images: [PNG_B64] } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      const rdPro = await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST });
      assert.equal(rdPro.cost_micro_usd, 180_000); // rd_pro__default: $0.18
      assert.equal(rdPro.cost_source, "estimated");
      const rdFast = await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "b.png", style: "rd_fast__default" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST });
      assert.equal(rdFast.cost_micro_usd, 30_000); // rd_fast: $0.03
    },
  );
});

test("retrodiffusion provider errors and failed tasks throw with the provider message", async () => {
  const ws = tempWorkspace();
  await withServer(
    (_req, _count, res) => json(res, 402, { error: { code: "not_enough_balance", message: "Not enough balance.", request_id: "r" } }),
    async ({ baseUrl }) => {
      await assert.rejects(
        generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST }),
        /Not enough balance/,
      );
    },
  );
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "t-4" });
      else if (req.url === "/v2/inferences/tasks/t-4") json(res, 200, { status: "failed", error: { status_code: 500, detail: "inference_failed: provider melted" } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST }),
        /inference_failed|provider melted/,
      );
    },
  );
});

test("retrodiffusion accepts frames as frames_duration + spritesheet for animation styles", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "t-5" });
      else if (req.url === "/v2/inferences/tasks/t-5") json(res, 200, { status: "succeeded", result: { base64_images: [PNG_B64], balance_cost: 0.14 } });
      else json(res, 404, {});
    },
    async ({ baseUrl, requests }) => {
      const r = await generate(
        { provider: "retrodiffusion", prompt: "walk", width: 64, height: 64, out: "walk.png", frames: 8, style: "rd_advanced_animation__walking" },
        { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST },
      );
      assert.equal(r.cost_micro_usd, 140_000);
      const post = requests.find((x) => x.method === "POST")!;
      assert.equal(post.body.frames_duration, 8);
      assert.equal(post.body.return_spritesheet, true);
    },
  );
  const ws2 = tempWorkspace();
  await assert.rejects(
    generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png", frames: 5 }, { workspace: ws2, baseUrl: { retrodiffusion: "http://127.0.0.1:1" }, env: ENV, ...FAST }),
    /frames_duration/,
  );
});

// ---- PixelLab ----

test("pixellab success: bearer auth, request shape, base64 result from the job poll, reported cost", async () => {
  const ws = tempWorkspace();
  writeFileSync(path.join(ws, "anchor.png"), PNG_BYTES);
  await withServer(
    (req, count, res) => {
      if (req.method === "POST" && req.url === "/v2/generate-image-v2") json(res, 202, { background_job_id: "job-1", status: "processing", usage: { type: "usd", usd: 0.02 } });
      else if (req.url === "/v2/background-jobs/job-1")
        json(res, 200, count === 1 ? { id: "job-1", status: "processing" } : { id: "job-1", status: "completed", created_at: "t", last_response: { image: { type: "base64", base64: PNG_B64, format: "png" } }, usage: { type: "usd", usd: 0.02 } });
      else json(res, 404, {});
    },
    async ({ baseUrl, requests }) => {
      const result = await generate(
        { provider: "pixellab", prompt: "a wizard", width: 64, height: 64, out: "gen/wiz.png", reference: "anchor.png", seed: 3 },
        { workspace: ws, baseUrl: { pixellab: baseUrl }, env: ENV, ...FAST },
      );
      assert.deepEqual(result.images, ["gen/wiz.png"]);
      assert.equal(result.cost_micro_usd, 20_000);
      assert.equal(result.cost_source, "reported");
      assert.equal((result.metadata as { background_job_id: string }).background_job_id, "job-1");

      const post = requests.find((r) => r.method === "POST")!;
      assert.equal(post.headers["authorization"], "Bearer pl-test-token");
      assert.equal(post.body.description, "a wizard");
      assert.deepEqual(post.body.image_size, { width: 64, height: 64 });
      assert.equal(post.body.no_background, true);
      assert.equal(post.body.seed, 3);
      assert.equal(post.body.reference_images.length, 1);
      assert.equal(post.body.reference_images[0].image.base64, PNG_B64);
      assert.deepEqual(post.body.reference_images[0].size, { width: 2, height: 2 });
      assert.ok(!JSON.stringify(result.metadata).includes("pl-test-token"));
    },
  );
});

test("pixellab cost falls back to the $0.02 estimate and is marked estimated", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { background_job_id: "job-2", status: "processing", usage: null });
      else if (req.url === "/v2/background-jobs/job-2") json(res, 200, { id: "job-2", status: "completed", last_response: { image: { base64: PNG_B64 } }, usage: null });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      const result = await generate({ provider: "pixellab", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { pixellab: baseUrl }, env: ENV, ...FAST });
      assert.equal(result.cost_micro_usd, 20_000);
      assert.equal(result.cost_source, "estimated");
    },
  );
});

test("pixellab failed jobs throw; frames are unsupported for pixellab in this interface", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { background_job_id: "job-3", status: "processing", usage: null });
      else if (req.url === "/v2/background-jobs/job-3") json(res, 200, { id: "job-3", status: "failed", last_response: { detail: "generation exploded" } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        generate({ provider: "pixellab", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { pixellab: baseUrl }, env: ENV, ...FAST }),
        /generation exploded|failed/,
      );
    },
  );
  const ws2 = tempWorkspace();
  await assert.rejects(
    generate({ provider: "pixellab", prompt: "x", width: 64, height: 64, out: "a.png", frames: 8 }, { workspace: ws2, baseUrl: { pixellab: "http://127.0.0.1:1" }, env: ENV, ...FAST }),
    /frames/,
  );
});

// ---- shared guards ----

test("missing keys, path escapes, and timeouts fail loudly", async () => {
  const ws = tempWorkspace();
  await assert.rejects(
    generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: "http://127.0.0.1:1" }, env: {}, ...FAST }),
    /RETRO_DIFFUSION_API_KEY/,
  );
  await assert.rejects(
    generate({ provider: "pixellab", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { pixellab: "http://127.0.0.1:1" }, env: {}, ...FAST }),
    /PIXELLAB_API_KEY/,
  );
  await assert.rejects(
    generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "../evil.png" }, { workspace: ws, baseUrl: { retrodiffusion: "http://127.0.0.1:1" }, env: ENV, ...FAST }),
    /escape/,
  );
  await assert.rejects(
    generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png", reference: "../anchor.png" }, { workspace: ws, baseUrl: { retrodiffusion: "http://127.0.0.1:1" }, env: ENV, ...FAST }),
    /escape/,
  );
  assert.throws(() => resolveInside(ws, ".."), /escape/);

  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "t-stuck" });
      else if (req.url === "/v2/inferences/tasks/t-stuck") json(res, 200, { status: "running" });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      await assert.rejects(
        generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, pollIntervalMs: 1, timeoutMs: 100 }),
        /timed out|timeout/i,
      );
    },
  );
});

// ---- runner capability (art_generate) ----

import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";

function capabilityCtx(workspace: string): ToolContext {
  return { workspace, naive: null };
}

/** 32x32: a 2x block image — central 16x16 region (block cells 4..11) opaque, rest transparent. */
function blockySource(): Uint8Array {
  const img = makeImage(32, 32);
  const rgbv = [1, 2, 3];
  for (let by = 4; by < 12; by++)
    for (let bx = 4; bx < 12; bx++)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) img.data.set([...rgbv, 255], ((by * 2 + dy) * 32 + bx * 2 + dx) * 4);
  return encodePng(img);
}

test("art_generate capability: writes into the workspace, chains snap+lock+outline from the manifest", async () => {
  const ws = tempWorkspace();
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  writeFileSync(
    path.join(ws, "game", "assets", "manifest.json"),
    JSON.stringify({ schema_version: 1, style_bible: "docs/style-bible.md", grid: { w: 16, h: 16 }, palette: ["#010203", "#040506"], assets: [{ id: "gen", type: "sprite", path: "assets/sprites/gen.png", size: { w: 16, h: 16 }, palette: ["#010203"], anchor: null }] }),
  );
  const source = blockySource();
  const prev = { ...process.env };
  process.env.RETRO_DIFFUSION_API_KEY = "rdpk-cap-test";
  try {
    await withServer(
      (req, _count, res) => {
        if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "cap-1" });
        else if (req.url === "/v2/inferences/tasks/cap-1") json(res, 200, { status: "succeeded", result: { base64_images: [Buffer.from(source).toString("base64")], balance_cost: 0.019 } });
        else json(res, 404, {});
      },
      async ({ baseUrl }) => {
        process.env.RETRO_DIFFUSION_BASE_URL = baseUrl;
        const out = await IMPLS.art_generate.art_generate.run(
          {
            provider: "retrodiffusion",
            prompt: "a test sprite",
            width: 32,
            height: 32,
            out: "game/assets/sprites/gen.png",
            postprocess: { snap: true, lock: true, outline: "#040506" },
          },
          capabilityCtx(ws),
        );
        assert.equal(out.is_error, undefined, out.content);
        assert.equal(out.cost_micro_usd, 19_000); // charged to the run budget
        const parsed = JSON.parse(out.content) as { images: string[]; cost_source: string; postprocess: { snap: { scaleX: number; integerScale: boolean }; lock: { pixelsChanged: number }; outline: { color: string } } };
        assert.deepEqual(parsed.images, ["game/assets/sprites/gen.png"]);
        assert.equal(parsed.cost_source, "reported");
        assert.equal(parsed.postprocess.snap.scaleX, 2);
        assert.equal(parsed.postprocess.snap.integerScale, true);
        assert.equal(parsed.postprocess.lock.pixelsChanged, 0); // source already used the locked color
        assert.equal(parsed.postprocess.outline.color, "#040506");

        const img = decodePng(new Uint8Array(readFileSync(path.join(ws, "game/assets/sprites/gen.png"))));
        assert.equal(img.width, 16); // snapped from 32
        assert.equal(img.height, 16);
        const px = (x: number, y: number) => Array.from(img.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
        assert.deepEqual(px(4, 4), [1, 2, 3, 255]); // center still opaque
        assert.deepEqual(px(3, 4), [4, 5, 6, 255]); // outline on the 4-adjacent transparent cell
        assert.deepEqual(px(0, 0), [0, 0, 0, 0]);
      },
    );
  } finally {
    for (const name of ["RETRO_DIFFUSION_API_KEY", "RETRO_DIFFUSION_BASE_URL"] as const) {
      if (prev[name] === undefined) delete process.env[name];
      else process.env[name] = prev[name];
    }
  }
});

test("art_generate capability: errors are tool errors, not throws (missing manifest, missing key, path escape)", async () => {
  const ws = tempWorkspace();
  const prevKey = process.env.RETRO_DIFFUSION_API_KEY;
  const prevBase = process.env.RETRO_DIFFUSION_BASE_URL;
  process.env.RETRO_DIFFUSION_API_KEY = "rdpkguard-test";
  delete process.env.RETRO_DIFFUSION_BASE_URL;
  try {

  // generation succeeds against a fake server; postprocess then fails on the missing manifest
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "guard-1" });
      else if (req.url === "/v2/inferences/tasks/guard-1") json(res, 200, { status: "succeeded", result: { base64_images: [PNG_B64], balance_cost: 0.03 } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      process.env.RETRO_DIFFUSION_BASE_URL = baseUrl;
      const noManifest = await IMPLS.art_generate.art_generate.run(
        { provider: "retrodiffusion", prompt: "x", width: 16, height: 16, out: "gen.png", postprocess: { lock: true } },
        capabilityCtx(ws),
      );
      assert.equal(noManifest.is_error, true);
      assert.match(noManifest.content, /manifest/i);
    },
  );
  delete process.env.RETRO_DIFFUSION_API_KEY; // now the key is the missing thing
  const noKey = await IMPLS.art_generate.art_generate.run({ provider: "retrodiffusion", prompt: "x", width: 16, height: 16, out: "gen.png" }, capabilityCtx(ws));
  assert.equal(noKey.is_error, true);
  assert.match(noKey.content, /RETRO_DIFFUSION_API_KEY/);

  const escape = await IMPLS.art_generate.art_generate.run({ provider: "retrodiffusion", prompt: "x", width: 16, height: 16, out: "../evil.png" }, capabilityCtx(ws));
  assert.equal(escape.is_error, true);
  assert.match(escape.content, /escape/i);

  } finally {
    if (prevKey === undefined) delete process.env.RETRO_DIFFUSION_API_KEY;
    else process.env.RETRO_DIFFUSION_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.RETRO_DIFFUSION_BASE_URL;
    else process.env.RETRO_DIFFUSION_BASE_URL = prevBase;
  }
});

// ---- T3-fix regressions ----

test("T3-fix 1: failures after a paid submit carry the cost (timeout, failed job) — never a silent $0", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "fix-timeout" });
      else if (req.url === "/v2/inferences/tasks/fix-timeout") json(res, 200, { status: "running" });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      // timeout after a 202 with balance_cost unknown → estimate on the error
      const err = (await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, pollIntervalMs: 1, timeoutMs: 60 }).catch((e: unknown) => e)) as ChargedFailure;
      assert.ok(err instanceof ChargedFailure, `expected ChargedFailure, got ${err}`);
      assert.equal(err.cost_micro_usd > 0, true, "timeout error carries a positive cost");
      assert.equal(err.cost_source, "estimated (failed after submit)");
      assert.equal(err.cost_micro_usd, 180_000); // rd_pro__default estimate
    },
  );
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "fix-failed" });
      else if (req.url === "/v2/inferences/tasks/fix-failed") json(res, 200, { status: "failed", error: { status_code: 500, detail: "boom" } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      const err = (await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST }).catch((e: unknown) => e)) as ChargedFailure;
      assert.ok(err instanceof ChargedFailure);
      assert.equal(err.cost_micro_usd, 180_000);
    },
  );
  // failed job whose submit response carried usage → reported cost wins
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "fix-failed2", usage: { type: "usd", usd: 0.02 } });
      else if (req.url === "/v2/inferences/tasks/fix-failed2") json(res, 200, { status: "failed", error: { status_code: 500, detail: "boom" } });
      else json(res, 404, {});
    },
    async ({ baseUrl }) => {
      const err = (await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, ...FAST }).catch((e: unknown) => e)) as ChargedFailure;
      assert.ok(err instanceof ChargedFailure);
      assert.equal(err.cost_micro_usd, 20_000);
      assert.equal(err.cost_source, "reported");
    },
  );
});

test("T3-fix 1b: capability returns cost_micro_usd when postprocess fails after a successful generation", async () => {
  const ws = tempWorkspace(); // no game/manifest → postprocess must fail
  const prevKey = process.env.RETRO_DIFFUSION_API_KEY;
  const prevBase = process.env.RETRO_DIFFUSION_BASE_URL;
  process.env.RETRO_DIFFUSION_API_KEY = "rdpk-fix";
  try {
    await withServer(
      (req, _count, res) => {
        if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "cap-fix" });
        else if (req.url === "/v2/inferences/tasks/cap-fix") json(res, 200, { status: "succeeded", result: { base64_images: [PNG_B64], balance_cost: 0.18 } });
        else json(res, 404, {});
      },
      async ({ baseUrl }) => {
        process.env.RETRO_DIFFUSION_BASE_URL = baseUrl;
        const out = await IMPLS.art_generate.art_generate.run(
          { provider: "retrodiffusion", prompt: "x", width: 16, height: 16, out: "gen.png", postprocess: { lock: true } },
          capabilityCtx(ws),
        );
        assert.equal(out.is_error, true);
        assert.equal(out.cost_micro_usd, 180_000);
        assert.match(out.content, /manifest/i);
      },
    );
  } finally {
    for (const [name, value] of [["RETRO_DIFFUSION_API_KEY", prevKey], ["RETRO_DIFFUSION_BASE_URL", prevBase]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("T3-fix 2: postprocess snap targets the full asset (frames × grid), not one cell", async () => {
  const ws = tempWorkspace();
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  // manifest: grid 16x16; the entry is a 4-frame strip of 16x16 → 64x16
  writeFileSync(
    path.join(ws, "game", "assets", "manifest.json"),
    JSON.stringify({ schema_version: 1, style_bible: "s", grid: { w: 16, h: 16 }, palette: ["#010203", "#040506"], assets: [{ id: "walk", type: "sprite", path: "assets/sprites/walk.png", size: { w: 16, h: 16 }, frames: 4, palette: ["#010203"], anchor: null }] }),
  );
  // provider returns an UPSCALED 256x64 strip (4× scale of 64x16); blocks of 4x4 px uniform
  const img = makeImage(256, 64);
  for (let y = 0; y < 64; y += 4)
    for (let x = 0; x < 256; x += 4)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 2], [3, 2], [2, 3], [3, 3]] as const)
        img.data.set([1, 2, 3, 255], ((y + dy) * 256 + x + dx) * 4);
  const source = encodePng(img);
  const prevKey = process.env.RETRO_DIFFUSION_API_KEY;
  const prevBase = process.env.RETRO_DIFFUSION_BASE_URL;
  process.env.RETRO_DIFFUSION_API_KEY = "rdpk-fix2";
  try {
    await withServer(
      (req, _count, res) => {
        if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "snap-fix" });
        else if (req.url === "/v2/inferences/tasks/snap-fix") json(res, 200, { status: "succeeded", result: { base64_images: [Buffer.from(source).toString("base64")], balance_cost: 0.18 } });
        else json(res, 404, {});
      },
      async ({ baseUrl }) => {
        process.env.RETRO_DIFFUSION_BASE_URL = baseUrl;
        const out = await IMPLS.art_generate.art_generate.run(
          { provider: "retrodiffusion", prompt: "walk cycle", width: 256, height: 64, out: "game/assets/sprites/walk.png", frames: 4, postprocess: { snap: true } },
          capabilityCtx(ws),
        );
        assert.equal(out.is_error, undefined, out.content);
        const parsed = JSON.parse(out.content) as { postprocess: { snap: { scaleX: number; scaleY: number } } };
        assert.equal(parsed.postprocess.snap.scaleX, 4); // 256 → 64 (4 frames × 16), not 256 → 16
        const snapped = decodePng(new Uint8Array(readFileSync(path.join(ws, "game/assets/sprites/walk.png"))));
        assert.equal(snapped.width, 64);
        assert.equal(snapped.height, 16);
      },
    );
  } finally {
    for (const [name, value] of [["RETRO_DIFFUSION_API_KEY", prevKey], ["RETRO_DIFFUSION_BASE_URL", prevBase]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("T3-fix 4: a hung connection is cut by the deadline (AbortSignal), with the cost attached after submit", async () => {
  const ws = tempWorkspace();
  await withServer(
    (req, _count, res) => {
      if (req.method === "POST") json(res, 202, { status: "accepted", task_id: "hang" });
      // the poll never answers: no res.end()
      else void res;
    },
    async ({ baseUrl }) => {
      const t0 = Date.now();
      const err = (await generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "a.png" }, { workspace: ws, baseUrl: { retrodiffusion: baseUrl }, env: ENV, pollIntervalMs: 1, timeoutMs: 150 }).catch((e: unknown) => e)) as ChargedFailure;
      assert.ok(Date.now() - t0 < 2000, "deadline must cut a hung poll");
      assert.ok(err instanceof ChargedFailure, String(err));
      assert.equal(err.cost_micro_usd, 180_000);
    },
  );
});

test("T3-fix 5: out must end in .png (multi-image naming can't collide)", async () => {
  const ws = tempWorkspace();
  await assert.rejects(
    generate({ provider: "retrodiffusion", prompt: "x", width: 64, height: 64, out: "gen/take" }, { workspace: ws, baseUrl: { retrodiffusion: "http://127.0.0.1:1" }, env: ENV, ...FAST }),
    /\.png/,
  );
  const r = IMPLS.art_generate.art_generate.input.safeParse({ provider: "retrodiffusion", prompt: "x", width: 16, height: 16, out: "gen/take" });
  assert.equal(r.success, false);
});
