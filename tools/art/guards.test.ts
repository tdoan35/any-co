// T39: art_generate guards. Comfy is never locked out by the anchor winner; pre-call validation makes ZERO
// requests; the per-asset cap is exact (and race-free); a redo past the cap needs a human decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "./png.ts";
import { MAX_REGENERATIONS, markExhausted, outPathProblem, readGallery, recordAnchorWinner, statePaths } from "./credits.ts";
import { runCommand } from "./art.ts";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";
import { grantIssues } from "../../runner/spec.ts";
import { loadAgent } from "../../runner/load.ts";
import { runAgent } from "../../runner/run.ts";
import { FakeProvider } from "../../runner/providers.ts";
import { read as readLedger } from "../ledger/ledger.ts";

const PNG = encodePng(makeImage(32, 32));
const PALETTE = ["#1a1c2c", "#f4f4f4"];

interface Fakes { base: string; requests: () => number; plPosts: () => number; close: () => Promise<void> }

/** Fake PixelLab (USD credits, so no generations floor) + fake ComfyUI on one port; counts every request. */
async function fakes(): Promise<Fakes> {
  let requests = 0;
  let plPosts = 0;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/v2/balance") return send(res, 200, { credits: { type: "usd", usd: 5 } });
      if (req.method === "POST" && url === "/v2/generate-image-v2") {
        plPosts++;
        return send(res, 202, { background_job_id: "j1", usage: { type: "usd", usd: 0.02 } });
      }
      if (url === "/v2/background-jobs/j1") return send(res, 200, { status: "completed", usage: { type: "usd", usd: 0.02 }, last_response: { images: [{ type: "base64", base64: Buffer.from(PNG).toString("base64") }] } });
      if (url === "/system_stats") return send(res, 200, {});
      if (url === "/upload/image") return send(res, 200, { name: "ref.png", subfolder: "" });
      if (url === "/prompt") return send(res, 200, { prompt_id: "p-1", node_errors: {} });
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
  return { base, requests: () => requests, plPosts: () => plPosts, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A workspace with a game clone holding a locked manifest; `entries` are manifest asset entries. */
function ctxFor(entries: Array<Record<string, unknown>> = [], manifest = true): ToolContext {
  const ws = mkdtempSync(path.join(tmpdir(), "guards-"));
  mkdirSync(path.join(ws, "game", "assets", "anchors"), { recursive: true });
  writeFileSync(path.join(ws, "game", "assets", "anchors", "hero.png"), PNG);
  if (manifest)
    writeFileSync(path.join(ws, "game", "assets", "manifest.json"), JSON.stringify({ schema_version: 1, style_bible: "docs/style-bible.md", grid: { w: 16, h: 16 }, palette: PALETTE, assets: entries }));
  const runsDir = path.join(ws, "_runs");
  return { workspace: ws, naive: null, runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl"), run_id: "t39", agent: "art-director" };
}

async function withLab<T>(fn: (f: Fakes) => Promise<T>): Promise<T> {
  const f = await fakes();
  const prev = { ...process.env };
  Object.assign(process.env, { PIXELLAB_API_KEY: "pl-t39", PIXELLAB_BASE_URL: f.base, COMFY_BASE_URL: f.base, PIXELLAB_MIN_REMAINING: "" });
  try {
    return await fn(f);
  } finally {
    for (const k of ["PIXELLAB_API_KEY", "PIXELLAB_BASE_URL", "COMFY_BASE_URL", "PIXELLAB_MIN_REMAINING"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await f.close();
  }
}

const gen = (ctx: ToolContext, input: Record<string, unknown>) =>
  IMPLS.art_generate.art_generate.run({ provider: "pixellab", prompt: "x", width: 32, height: 32, out: "game/assets/sprites/hero.png", ...input }, ctx);

// ---- (a) comfy is never locked out by the anchor winner ----

test("T39a: a pixellab anchor winner does not refuse comfy; the lock still holds among paid providers", async () => {
  await withLab(async (f) => {
    const ctx = ctxFor();
    recordAnchorWinner(statePaths(ctx.runsDir).gallery, "game/assets/anchors/hero.png", "pixellab", "r", "lower drift");
    const r = await gen(ctx, { provider: "comfy", reference: "game/assets/anchors/hero.png" });
    assert.equal(r.is_error, undefined, r.content);
    assert.equal(JSON.parse(r.content).provider, "comfy");
    const rd = await gen(ctx, { provider: "retrodiffusion", reference: "game/assets/anchors/hero.png", out: "game/assets/sprites/b.png" });
    assert.equal(rd.is_error, true);
    assert.match(rd.content, /anchor bake-off was won by pixellab/);
    assert.equal(f.plPosts(), 0);
  });
});

// ---- (b) pre-call validation: refused with ZERO requests ----

test("T39b1/b2: outs without a real file name, or outside the clone's assets/, are refused with zero requests", async () => {
  await withLab(async (f) => {
    const ctx = ctxFor();
    for (const out of [".png", "game/assets/.png", "game/assets/sprites/.hidden.png", "assets/x/.png"]) {
      const r = await gen(ctx, { out });
      assert.equal(r.is_error, true, out);
      assert.match(r.content, /refused before any request: .*has no real file name/, out);
    }
    for (const out of ["art/hero.png", "game/hero.png", "game/assets/../hero.png", "assets/hero.png", "/tmp/hero.png"]) {
      const r = await gen(ctx, { out });
      assert.equal(r.is_error, true, out);
      assert.match(r.content, /refused before any request: .*not under the game clone's assets\//, out);
    }
    assert.equal(f.requests(), 0, "no request of any kind");
    assert.deepEqual(readGallery(statePaths(ctx.runsDir).gallery).generations, {}, "nothing counted");
    assert.equal(outPathProblem("game/assets/sprites/hero-v2.png"), null);
    assert.equal(outPathProblem("./game/assets/a.png"), null);
  });
});

test("T39b3: postprocess without the manifest, without the asset's entry, or with an incomplete entry is refused with zero requests", async () => {
  await withLab(async (f) => {
    const pp = { postprocess: { snap: true, lock: true, outline: "#1a1c2c" } };
    const cases: Array<[ToolContext, RegExp]> = [
      [ctxFor([], false), /needs the game manifest/],
      [ctxFor([{ id: "other", type: "sprite", path: "assets/sprites/other.png", size: { w: 16, h: 16 }, palette: PALETTE, anchor: null }]), /no manifest entry for assets\/sprites\/hero.png: add its entry .* FIRST/],
      [ctxFor([{ id: "hero", type: "sprite", path: "assets/sprites/hero.png", palette: PALETTE, anchor: null }]), /has no size/],
      [ctxFor([{ id: "hero", type: "sprite", path: "assets/sprites/hero.png", size: { w: 20, h: 16 }, palette: PALETTE, anchor: null }]), /not a multiple of grid 16x16/],
    ];
    for (const [ctx, re] of cases) {
      const r = await gen(ctx, pp);
      assert.equal(r.is_error, true);
      assert.match(r.content, re);
    }
    const outlineOnly = await gen(ctxFor([]), { postprocess: { outline: "#1a1c2c" } });
    assert.match(outlineOnly.content, /no manifest entry/, "any postprocess step needs the entry");
    assert.equal(f.requests(), 0);
    // a complete entry passes the check and generates
    const ok = await gen(ctxFor([{ id: "hero", type: "sprite", path: "assets/sprites/hero.png", size: { w: 16, h: 16 }, palette: PALETTE, anchor: null }]), pp);
    assert.equal(ok.is_error, undefined, ok.content);
    assert.equal(f.plPosts(), 1);
    // no postprocess: no manifest needed
    assert.equal((await gen(ctxFor([], false), { out: "game/assets/sprites/raw.png" })).is_error, undefined);
  });
});

// ---- (c) the cap: exactly 1 + MAX_REGENERATIONS paid calls per out path, race-free ----

test("T39c: exactly 1 + MAX_REGENERATIONS paid calls per asset; the next is refused before any request", async () => {
  await withLab(async (f) => {
    const ctx = ctxFor();
    for (let n = 1; n <= 1 + MAX_REGENERATIONS; n++) {
      const r = await gen(ctx, {});
      assert.equal(JSON.parse(r.content).generation, `${n} of ${1 + MAX_REGENERATIONS}`);
    }
    const posts = f.plPosts();
    const refused = await gen(ctx, { out: "./game/assets/sprites/hero.png" }); // same asset, other spelling
    assert.equal(refused.is_error, true);
    assert.match(refused.content, /has had 3 paid generations .* NEW out path \(e\.g\. \.\/game\/assets\/sprites\/hero-v2\.png\).*art_redo/);
    assert.equal(f.plPosts(), posts, "no request for the refused call");
    assert.equal(readGallery(statePaths(ctx.runsDir).gallery).generations["assets/sprites/hero.png"], 3);
    assert.equal(JSON.parse((await gen(ctx, { out: "game/assets/sprites/other.png" })).content).generation, "1 of 3", "another asset has its own key");
  });
});

test("T39c: concurrent calls cannot overshoot the cap (the 4-of-3 race); an unbilled call gives its slot back", async () => {
  await withLab(async (f) => {
    const ctx = ctxFor();
    const results = await Promise.all(Array.from({ length: 5 }, () => gen(ctx, {})));
    assert.equal(results.filter((r) => !r.is_error).length, 3);
    assert.equal(results.filter((r) => r.is_error && /has had 3 paid generations/.test(r.content)).length, 2);
    assert.equal(f.plPosts(), 3);
    assert.equal(readGallery(statePaths(ctx.runsDir).gallery).generations["assets/sprites/hero.png"], 3);

    const ctx2 = ctxFor();
    for (const p of ["pixellab", "retrodiffusion"] as const) markExhausted(statePaths(ctx2.runsDir).providers, p, { reason: "test" });
    const floor = JSON.parse((await gen(ctx2, {})).content);
    assert.equal(floor.fallback, "procedural");
    assert.equal(readGallery(statePaths(ctx2.runsDir).gallery).generations["assets/sprites/hero.png"], undefined, "procedural billed nothing: slot released");
  });
});

// ---- (d) a redo past the cap needs a human decision ----

test("T39d: art_redo is approval-only (a spec can never grant it allow) and a denied request grants nothing", async () => {
  assert.match(grantIssues({ art_signoff: "allow" }).map((i) => i.message).join(" "), /human decision: grant it "ask"/);
  assert.deepEqual(grantIssues({ art_signoff: "ask" }), []);
  assert.throws(() => IMPLS.art_generate.art_generate.input.parse({ provider: "pixellab", prompt: "x", width: 32, height: 32, out: "game/assets/a.png", redo: true }), "art_generate has no reset input");
  // the model asks; the gate's approver (default: deny) says no → the tool body never runs
  const spec = await loadAgent("art-director");
  const runsDir = mkdtempSync(path.join(tmpdir(), "guards-run-"));
  const fake = new FakeProvider([{ content: [{ type: "tool_use", id: "r1", name: "art_redo", input: { out: "game/assets/anchors/reaper.png", why: "operator wants a darker cloak" } }] }]);
  await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir, runId: "deny" }).catch(() => undefined);
  assert.deepEqual(readGallery(statePaths(runsDir).gallery).redos, {}, "no grant without an approval");
  assert.match(JSON.stringify(fake.requests.at(-1)?.messages.at(-1)), /a human declined this action/);
});

test("T39d: an approved art_redo (or the operator CLI) gives exactly one fresh allowance, ledgered", async () => {
  await withLab(async (f) => {
    const ctx = ctxFor();
    for (let n = 0; n < 3; n++) await gen(ctx, {});
    assert.equal((await gen(ctx, {})).is_error, true);
    // what runs after the operator approved the request in the queue
    const g = await IMPLS.art_signoff.art_redo.run({ out: "game/assets/sprites/hero.png", why: "Ty signed off a redo with a new silhouette" }, ctx);
    assert.equal(g.is_error, undefined, g.content);
    assert.deepEqual(JSON.parse(g.content), { redo: "granted", out: "game/assets/sprites/hero.png", allowance: 3, generations_before: 3 });
    for (let n = 1; n <= 3; n++) assert.equal(JSON.parse((await gen(ctx, {})).content).generation, `${n} of 3`);
    assert.equal((await gen(ctx, {})).is_error, true, "the fresh allowance is exactly 1 + MAX_REGENERATIONS again");
    assert.equal(f.plPosts(), 6);
    assert.equal(readLedger(ctx.ledgerFile!).filter((e) => e.kind === "decision" && e.topic === "art.redo").length, 1);
    assert.equal((await IMPLS.art_signoff.art_redo.run({ out: ".png", why: "a long enough reason" }, ctx)).is_error, true);

    // operator CLI: same grant, ledgered as an intervention
    const cliRuns = mkdtempSync(path.join(tmpdir(), "guards-cli-"));
    const prev = { gallery: process.env.ART_GALLERY_FILE, ledger: process.env.STUDIO_LEDGER_FILE };
    process.env.ART_GALLERY_FILE = path.join(cliRuns, "art-gallery.json");
    process.env.STUDIO_LEDGER_FILE = path.join(cliRuns, "ledger.jsonl");
    try {
      const bad = runCommand(["redo", "game/assets/anchors/reaper.png"]);
      assert.equal(bad.exitCode, 2);
      const okCli = runCommand(["redo", "game/assets/anchors/reaper.png", "--why", "Ty signed off the reaper redo"]);
      assert.equal(okCli.exitCode, 0, JSON.stringify(okCli.json));
      assert.equal(readGallery(process.env.ART_GALLERY_FILE).redos?.["assets/anchors/reaper.png"]?.length, 1);
      const iv = readLedger(process.env.STUDIO_LEDGER_FILE).filter((e) => e.kind === "intervention");
      assert.equal(iv.length, 1);
      assert.match(JSON.stringify(iv[0]), /art redo granted for game\/assets\/anchors\/reaper.png/);
    } finally {
      if (prev.gallery === undefined) delete process.env.ART_GALLERY_FILE;
      else process.env.ART_GALLERY_FILE = prev.gallery;
      if (prev.ledger === undefined) delete process.env.STUDIO_LEDGER_FILE;
      else process.env.STUDIO_LEDGER_FILE = prev.ledger;
    }
  });
});
