// T35: the mechanical PixelLab floor (PIXELLAB_MIN_REMAINING). Fake PixelLab + fake lab ComfyUI on one server; no live calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "./png.ts";
import { PIXELLAB_DEFAULT_CALL_ESTIMATE, checkPixellabFloor, markExhausted, pixellabCallEstimate, pixellabFloor, readProviders, statePaths } from "./credits.ts";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";
import { read as readLedger } from "../ledger/ledger.ts";

const PNG = encodePng(makeImage(16, 16));
const gens = (n: number) => ({ remaining: n, unit: "generations" as const, total: 2000 });

test("T35 rule: at/below the floor and a call that would cross it are blocked; above passes; unreadable fails closed", () => {
  assert.equal(checkPixellabFloor(gens(1190), 1000, 30).blocked, false);
  const at = checkPixellabFloor(gens(1000), 1000, 30);
  assert.deepEqual([at.blocked, at.reason], [true, "at_floor"]);
  assert.equal(at.message, "PixelLab floor reached (remaining 1000 <= 1000): use provider comfy with your reference image, or stop and report");
  assert.equal(checkPixellabFloor(gens(900), 1000, 30).reason, "at_floor");
  const cross = checkPixellabFloor(gens(1020), 1000, 30);
  assert.deepEqual([cross.blocked, cross.reason], [true, "would_cross"]);
  assert.match(cross.message, /remaining 1020 - up to 30 for this call < 1000/);
  assert.equal(checkPixellabFloor(gens(1030), 1000, 30).blocked, false, "exactly floor + estimate is allowed");
  assert.deepEqual([checkPixellabFloor(null, 1000, 30).blocked, checkPixellabFloor(null, 1000, 30).reason], [true, "unreadable"]);
  assert.equal(checkPixellabFloor({ remaining: 0.5, unit: "usd", total: null }, 1000, 30).blocked, false, "a USD balance is outside a generations floor");
  assert.equal(pixellabFloor({}), null);
  assert.equal(pixellabFloor({ PIXELLAB_MIN_REMAINING: " " }), null);
  assert.equal(pixellabFloor({ PIXELLAB_MIN_REMAINING: "1000" }), 1000);
  assert.throws(() => pixellabFloor({ PIXELLAB_MIN_REMAINING: "lots" }), /non-negative integer/);
  const dir = mkdtempSync(path.join(tmpdir(), "floor-"));
  const credits = path.join(dir, "art-credits.jsonl");
  assert.equal(pixellabCallEstimate(credits), PIXELLAB_DEFAULT_CALL_ESTIMATE);
  for (const used of [4, 12, null, 3])
    appendFileSync(credits, JSON.stringify({ ts: "2026-11-08T00:00:00Z", provider: "pixellab", remaining: 1, unit: "generations", generations_used: used, run_id: "r", source: "generation" }) + "\n");
  assert.equal(pixellabCallEstimate(credits), 12, "the most one call has used");
});

// ---- capability ----

interface Lab { base: string; plPosts: () => number; comfyPrompts: () => number; close: () => Promise<void> }

/** PixelLab with a live generations balance (each still costs `perCall`) and an optional ComfyUI on the same port. */
async function fakes(state: { generations: number; perCall: number; comfy: boolean }): Promise<Lab> {
  let plPosts = 0;
  let prompts = 0;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/v2/balance") return send(res, 200, { credits: { type: "usd", usd: 0 }, subscription: { type: "generations", status: "active", generations: state.generations, total: 2000 } });
      if (req.method === "POST" && url === "/v2/generate-image-v2") {
        plPosts++;
        state.generations -= state.perCall;
        return send(res, 202, { background_job_id: "j1", status: "processing" });
      }
      if (url === "/v2/background-jobs/j1") return send(res, 200, { status: "completed", last_response: { images: [{ type: "base64", base64: Buffer.from(PNG).toString("base64") }] } });
      if (!state.comfy) return send(res, 503, {});
      if (url === "/system_stats" || url === "/queue") return send(res, 200, {});
      if (url === "/upload/image") return send(res, 200, { name: "ref.png", subfolder: "" });
      if (url === "/prompt") {
        prompts++;
        return send(res, 200, { prompt_id: "p-1", node_errors: {} });
      }
      if (url === "/history/p-1") return send(res, 200, { "p-1": { status: { completed: true }, outputs: { "7": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } } } });
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
  return { base, plPosts: () => plPosts, comfyPrompts: () => prompts, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function ctxFor(): ToolContext {
  const ws = mkdtempSync(path.join(tmpdir(), "floor-ws-"));
  mkdirSync(path.join(ws, "game", "assets"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "anchor.png"), PNG);
  const runsDir = path.join(ws, "_runs");
  return { workspace: ws, naive: null, runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl"), run_id: "t35", agent: "art-director" };
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const gen = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  IMPLS.art_generate.art_generate.run({ provider: "pixellab", prompt: "x", width: 16, height: 16, out: `game/assets/a-${Math.random().toString(36).slice(2, 8)}.png`, reference: "game/assets/anchor.png", ...extra }, ctx);
const floorNotes = (ctx: ToolContext) => readLedger(ctx.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "spend.pixellab_floor");

async function scenario(state: { generations: number; perCall: number; comfy: boolean }, env: Record<string, string>, fn: (lab: Lab, ctx: ToolContext) => Promise<void>) {
  const lab = await fakes(state);
  try {
    await withEnv({ PIXELLAB_API_KEY: "pl-t35", PIXELLAB_BASE_URL: lab.base, COMFY_BASE_URL: lab.base, ...env }, () => fn(lab, ctxFor()));
  } finally {
    await lab.close();
  }
}

test("T35: above floor + estimate, pixellab generates as usual", async () => {
  await scenario({ generations: 1190, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "1000" }, async (lab, ctx) => {
    const out = JSON.parse((await gen(ctx)).content);
    assert.equal(out.provider, "pixellab");
    assert.equal(out.generations_used, 4);
    assert.equal(out.pixellab_floor, undefined);
    assert.equal(lab.plPosts(), 1);
  });
});

test("T35: at the floor → no pixellab request; comfy takes the call; ONE ledger note per day; pixellab never persisted exhausted", async () => {
  await scenario({ generations: 1000, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "1000" }, async (lab, ctx) => {
    const r = await gen(ctx);
    assert.equal(r.is_error, undefined, r.content);
    const out = JSON.parse(r.content);
    assert.equal(out.provider, "comfy");
    assert.equal(out.fallback_from, "pixellab");
    assert.equal(out.pixellab_floor.reason, "at_floor");
    assert.match(out.notes.join(" "), /PixelLab floor reached \(remaining 1000 <= 1000\): use provider comfy with your reference image, or stop and report/);
    assert.match(out.notes.join(" "), /pixellab is at its floor; tried comfy once instead/);
    assert.equal(lab.plPosts(), 0, "no pixellab request");
    assert.equal(lab.comfyPrompts(), 1);
    await gen(ctx); // still at the floor
    assert.equal(lab.plPosts(), 0);
    const notes = floorNotes(ctx);
    assert.equal(notes.length, 1, "one note per day");
    assert.match((notes[0] as { decision: string }).decision, /remaining 1000, floor 1000/);
    assert.equal(readProviders(statePaths(ctx.runsDir).providers).pixellab, undefined, "the floor is never persisted as exhausted");
  });
});

test("T35: a call that would cross the floor is refused; a measured smaller per-call cost lets it through", async () => {
  await scenario({ generations: 1020, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "1000" }, async (lab, ctx) => {
    const out = JSON.parse((await gen(ctx)).content);
    assert.equal(out.pixellab_floor.reason, "would_cross");
    assert.equal(out.pixellab_floor.estimate, 30, "default estimate before anything is measured");
    assert.equal(lab.plPosts(), 0);
    mkdirSync(ctx.runsDir!, { recursive: true });
    appendFileSync(statePaths(ctx.runsDir).credits, JSON.stringify({ ts: new Date().toISOString(), provider: "pixellab", remaining: 1020, unit: "generations", generations_used: 4, run_id: "r", source: "generation" }) + "\n");
    const ok = JSON.parse((await gen(ctx)).content);
    assert.equal(ok.provider, "pixellab", "1020 - 4 >= 1000");
    assert.equal(lab.plPosts(), 1);
  });
});

test("T35: below the floor with the lab down and Retro Diffusion exhausted → the procedural floor, with the floor message", async () => {
  await scenario({ generations: 900, perCall: 4, comfy: false }, { PIXELLAB_MIN_REMAINING: "1000" }, async (lab, ctx) => {
    markExhausted(statePaths(ctx.runsDir).providers, "retrodiffusion", { reason: "test: out of credits" });
    const r = await gen(ctx);
    assert.equal(r.is_error, undefined, r.content);
    assert.equal(r.cost_micro_usd, 0);
    const out = JSON.parse(r.content);
    assert.equal(out.exhausted, "all");
    assert.equal(out.fallback, "procedural");
    assert.deepEqual(out.unavailable, ["comfy"]);
    assert.equal(out.pixellab_floor.reason, "at_floor");
    assert.match(out.next, /^PixelLab floor reached \(remaining 900 <= 1000\): use provider comfy with your reference image, or stop and report/);
    assert.equal(lab.plPosts(), 0);
    assert.equal(readProviders(statePaths(ctx.runsDir).providers).pixellab, undefined);
    assert.equal(floorNotes(ctx).length, 1);
  });
});

test("T35: an animation at the floor gets no comfy fallback (stills only); no floor set = no balance gate", async () => {
  await scenario({ generations: 900, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "1000" }, async (lab, ctx) => {
    markExhausted(statePaths(ctx.runsDir).providers, "retrodiffusion", { reason: "test" });
    const out = JSON.parse((await gen(ctx, { frames: 4, justify: "walk cycle for the hero" })).content);
    assert.equal(out.fallback, "procedural");
    assert.match(out.notes.join(" "), /comfy makes stills only/);
    assert.equal(lab.comfyPrompts(), 0);
    assert.equal(lab.plPosts(), 0);
  });
  await scenario({ generations: 900, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "" }, async (lab, ctx) => {
    const out = JSON.parse((await gen(ctx)).content);
    assert.equal(out.provider, "pixellab", "without PIXELLAB_MIN_REMAINING only a real 402 stops pixellab");
    assert.equal(lab.plPosts(), 1);
  });
});

test("T35: a malformed PIXELLAB_MIN_REMAINING is an error, never a silently missing floor", async () => {
  await scenario({ generations: 900, perCall: 4, comfy: true }, { PIXELLAB_MIN_REMAINING: "1k" }, async (lab, ctx) => {
    const r = await gen(ctx);
    assert.equal(r.is_error, true);
    assert.match(r.content, /PIXELLAB_MIN_REMAINING must be a non-negative integer/);
    assert.equal(lab.plPosts(), 0);
  });
});
