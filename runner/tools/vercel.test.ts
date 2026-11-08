// T52: vercel_deploy / vercel_status against a fake Vercel REST server (never the real API).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERCEL_POLL, mergeVercelJson, vercelDeployTools, vercelStatusTools } from "./vercel.ts";
import type { ToolContext } from "./kit.ts";
import { CAPABILITIES } from "./registry.ts";
import { loadAgent } from "../load.ts";

const TOKEN = "vcp_T0KEN_secret_abcdef123456";
interface Seen { method: string; url: string; auth?: string; digest?: string; ctype?: string; bytes: Buffer; json: any }
let server: Server;
let base = "";
let seen: Seen[] = [];
const blobs = new Map<string, Buffer>();
let polls = 0;
let failCreateOnce: "missing" | "leak" | null = null;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      let json: any = null;
      if (req.headers["content-type"] === "application/json") json = JSON.parse(bytes.toString());
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, digest: req.headers["x-vercel-digest"] as string | undefined, ctype: req.headers["content-type"], bytes, json });
      const send = (s: number, d: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(d)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { error: { code: "forbidden", message: `Not authorized: ${req.headers.authorization}` } });
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/v2/files") {
        const sha = createHash("sha1").update(bytes).digest("hex");
        if (sha !== req.headers["x-vercel-digest"]) return send(400, { error: { code: "invalid_digest", message: "Digest is not valid" } });
        blobs.set(sha, bytes);
        return send(200, { urls: [] });
      }
      if (u.pathname === "/v13/deployments" && req.method === "POST") {
        if (failCreateOnce === "leak") { failCreateOnce = null; return send(500, { error: { code: "internal", message: `token ${TOKEN} rejected` } }); }
        const missing = json.files.map((f: any) => f.sha).filter((s: string) => !blobs.has(s));
        if (failCreateOnce === "missing") { failCreateOnce = null; blobs.delete(json.files[0].sha); return send(400, { error: { code: "missing_files", message: "Missing files", missing: [json.files[0].sha] } }); }
        if (missing.length) return send(400, { error: { code: "missing_files", message: "Missing files", missing } });
        polls = 0;
        return send(200, { id: "dpl_1", url: `${json.name}-abc.vercel.app`, readyState: "QUEUED", target: json.target ?? null, alias: [], aliasAssigned: false });
      }
      if (u.pathname === "/v13/deployments/dpl_1") {
        polls++;
        return send(200, polls < 2 ? { id: "dpl_1", url: "studio-abc.vercel.app", readyState: "BUILDING" } : { id: "dpl_1", url: "studio-abc.vercel.app", readyState: "READY", target: "production", alias: ["studio.vercel.app"], aliasAssigned: true });
      }
      if (u.pathname === "/v2/deployments/dpl_1/aliases") return send(200, { alias: json.alias, created: "2026-11-08T17:00:00Z", oldDeploymentId: null, uid: "al_1" });
      if (u.pathname === "/v9/projects/studio") return send(200, { id: "prj_1", name: "studio", framework: null, targets: { production: { alias: ["getany.org"] } } });
      if (u.pathname === "/v7/deployments") return send(200, { deployments: [{ uid: "dpl_1", url: "studio-abc.vercel.app", state: "READY", target: "production", created: 1 }], pagination: {} });
      if (u.pathname === "/v4/aliases") return send(200, { aliases: [{ alias: "getany.org", deploymentId: "dpl_1" }] });
      send(404, { error: { code: "not_found", message: "nope" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
const ENV = ["VERCEL_TOKEN", "VERCEL_API_BASE_URL", "VERCEL_TEAM_ID", "VERCEL_MAX_FILE_MB", "VERCEL_MAX_TOTAL_MB"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
after(() => { for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });
beforeEach(() => {
  seen = [];
  blobs.clear();
  failCreateOnce = null;
  process.env.VERCEL_TOKEN = TOKEN;
  process.env.VERCEL_API_BASE_URL = base;
  for (const k of ["VERCEL_TEAM_ID", "VERCEL_MAX_FILE_MB", "VERCEL_MAX_TOTAL_MB"] as const) delete process.env[k];
  Object.assign(VERCEL_POLL, { firstMs: 5, maxMs: 10, timeoutMs: 5000 });
});

/** A workspace with site/ (home) and a Godot-shaped export at game/dist/web. */
function ws(): ToolContext {
  const workspace = mkdtempSync(path.join(tmpdir(), "vercel-ws-"));
  mkdirSync(path.join(workspace, "site"), { recursive: true });
  writeFileSync(path.join(workspace, "site", "index.html"), "<h1>studio</h1>");
  writeFileSync(path.join(workspace, "site", ".env"), "SECRET=1");
  const web = path.join(workspace, "game", "dist", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<script src=index.js></script>");
  writeFileSync(path.join(web, "index.js"), "const GODOT_THREADS_ENABLED = false;");
  writeFileSync(path.join(web, "index.wasm"), Buffer.alloc(4096, 7));
  writeFileSync(path.join(web, "index.pck"), Buffer.alloc(1024, 3));
  return { workspace, naive: null, agent: "build-release", run_id: "r1" };
}
const deploy = (input: Record<string, unknown>, c: ToolContext) => vercelDeployTools.vercel_deploy.run(vercelDeployTools.vercel_deploy.input.parse(input), c);
const GAME = { dir: "site", mounts: [{ path: "game/dist/web", at: "caravan-cargo-cult" }], project: "studio", production: true };

test("T52: deploy uploads every file by sha1, creates a static production deployment, polls to READY, assigns the alias", async () => {
  const c = ws();
  const r = await deploy({ ...GAME, alias: "getany.org" }, c);
  assert.equal(r.is_error, undefined, r.content);
  const j = JSON.parse(r.content);
  assert.equal(j.ready, true);
  assert.equal(j.url, "https://studio-abc.vercel.app");
  assert.deepEqual(j.alias, { ok: true, alias: "getany.org", old_deployment: null });
  assert.deepEqual(j.skipped_hidden, [".env"], "hidden files are never published");
  const uploads = seen.filter((s) => s.url === "/v2/files");
  for (const u of uploads) {
    assert.equal(u.digest, createHash("sha1").update(u.bytes).digest("hex"));
    assert.equal(u.ctype, "application/octet-stream");
  }
  assert.ok(!uploads.some((u) => u.bytes.toString() === "SECRET=1"));
  const create = seen.find((s) => s.url.startsWith("/v13/deployments?"))!;
  assert.match(create.url, /skipAutoDetectionConfirmation=1/);
  assert.equal(create.json.target, "production");
  assert.equal(create.json.name, "studio");
  assert.equal("project" in create.json, false, "name alone, so a first deploy creates the project");
  assert.deepEqual(create.json.projectSettings, { framework: null, buildCommand: null, installCommand: null, outputDirectory: null });
  assert.deepEqual(create.json.files.map((f: any) => f.file), ["caravan-cargo-cult/index.html", "caravan-cargo-cult/index.js", "caravan-cargo-cult/index.pck", "caravan-cargo-cult/index.wasm", "index.html", "vercel.json"]);
  const wasm = create.json.files.find((f: any) => f.file.endsWith(".wasm"));
  assert.equal(wasm.size, 4096);
  assert.ok(seen.filter((s) => s.url === "/v13/deployments/dpl_1").length >= 2, "polled until READY");
  assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`));
  assert.ok(!r.content.includes(TOKEN));
});

test("T52: vercel.json is written/merged: COOP+COEP on each wasm dir, application/wasm, trailingSlash; existing rules kept", async () => {
  const c = ws();
  writeFileSync(path.join(c.workspace, "site", "vercel.json"), JSON.stringify({ trailingSlash: false, headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }] }));
  const r = await deploy({ ...GAME, mounts: [...GAME.mounts, { path: "game/dist/web", at: "soul-shift" }] }, c);
  assert.equal(r.is_error, undefined, r.content);
  const written = JSON.parse(readFileSync(path.join(c.workspace, "site", "vercel.json"), "utf8"));
  const rule = (src: string) => written.headers.find((h: any) => h.source === src);
  for (const d of ["caravan-cargo-cult", "soul-shift"]) {
    for (const src of [`/${d}`, `/${d}/(.*)`]) {
      assert.deepEqual(rule(src).headers, [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }, { key: "Cross-Origin-Embedder-Policy", value: "require-corp" }]);
    }
  }
  assert.deepEqual(rule("/(.*).wasm").headers, [{ key: "Content-Type", value: "application/wasm" }]);
  assert.deepEqual(rule("/(.*)").headers, [{ key: "X-Frame-Options", value: "DENY" }], "their rule kept, not isolated: the home page has no wasm");
  assert.equal(written.trailingSlash, false, "an explicit setting is theirs");
  // the uploaded vercel.json is the merged one
  const vjSha = seen.find((s) => s.url.startsWith("/v13/deployments?"))!.json.files.find((f: any) => f.file === "vercel.json").sha;
  assert.deepEqual(JSON.parse(blobs.get(vjSha)!.toString()), written);
  assert.equal(mergeVercelJson(null, [""]).headers[0].source, "/(.*)", "a wasm at the root isolates the whole site");
  assert.equal(mergeVercelJson(null, []).trailingSlash, true);
});

test("T52: symlinks anywhere, escapes, the workspace root, a missing home page: refused with ZERO requests", async () => {
  const c = ws();
  const outside = mkdtempSync(path.join(tmpdir(), "vercel-out-"));
  writeFileSync(path.join(outside, "secret.txt"), "x");
  symlinkSync(path.join(outside, "secret.txt"), path.join(c.workspace, "game", "dist", "web", "leak.txt"));
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [GAME, /caravan-cargo-cult\/leak\.txt is a symlink/],
    [{ ...GAME, dir: "../" }, /escapes the workspace/],
    [{ ...GAME, dir: ".", mounts: [] }, /strictly inside your workspace/],
    [{ ...GAME, mounts: [{ path: "game/dist/web/../../../..", at: "x" }] }, /escapes the workspace/],
    [{ ...GAME, dir: "nohome", mounts: [] }, /index\.html is missing/],
  ];
  mkdirSync(path.join(c.workspace, "nohome"));
  writeFileSync(path.join(c.workspace, "nohome", "a.txt"), "a");
  symlinkSync(outside, path.join(c.workspace, "linkdir"));
  cases.push([{ ...GAME, dir: "linkdir", mounts: [] }, /through a symlink|is a symlink/]);
  for (const [input, re] of cases) {
    const r = await deploy(input, c);
    assert.equal(r.is_error, true, JSON.stringify(input));
    assert.match(r.content, re);
  }
  assert.equal(seen.length, 0);
});

test("T52: a file over the per-file limit (or a site over the total) is refused before any request, naming it", async () => {
  const c = ws();
  process.env.VERCEL_MAX_FILE_MB = "0.002"; // ~2 KB: the 4 KB index.wasm is over
  const r = await deploy(GAME, c);
  assert.equal(r.is_error, true);
  assert.match(r.content, /caravan-cargo-cult\/index\.wasm \(0\.0 MB\) over the 0 MB per-file limit \(VERCEL_MAX_FILE_MB\) \(no request was made\)/);
  delete process.env.VERCEL_MAX_FILE_MB;
  process.env.VERCEL_MAX_TOTAL_MB = "0.003";
  assert.match((await deploy(GAME, c)).content, /over VERCEL_MAX_TOTAL_MB/);
  assert.equal(seen.length, 0);
});

test("T52: missing_files is answered by re-uploading those shas; the token never appears in results or errors", async () => {
  const c = ws();
  failCreateOnce = "missing";
  const r = await deploy(GAME, c);
  assert.equal(r.is_error, undefined, r.content);
  assert.equal(seen.filter((s) => s.url.startsWith("/v13/deployments?")).length, 2);
  failCreateOnce = "leak";
  const bad = await deploy(GAME, ws());
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /failed \(500 internal\)/);
  assert.ok(!bad.content.includes(TOKEN), bad.content);
  // a wrong token echoed back by the server (Bearer …) is redacted too
  process.env.VERCEL_TOKEN = "wrongtoken_zzzzzz";
  const st = await vercelStatusTools.vercel_status.run({ project: "studio", limit: 5 }, c);
  assert.match(st.content, /403 forbidden/);
  assert.ok(!st.content.includes("wrongtoken_zzzzzz"), st.content);
  delete process.env.VERCEL_TOKEN;
  const n = seen.length;
  assert.match((await deploy(GAME, c)).content, /VERCEL_TOKEN is not set.*no request was made/);
  assert.equal(seen.length, n);
});

test("T52: VERCEL_TEAM_ID scopes every call; vercel_status lists deployments and aliases", async () => {
  const c = ws();
  process.env.VERCEL_TEAM_ID = "team_42";
  const st = await vercelStatusTools.vercel_status.run({ project: "studio", limit: 3 }, c);
  assert.equal(st.is_error, undefined, st.content);
  const j = JSON.parse(st.content);
  assert.deepEqual(j.production_domains, ["getany.org"]);
  assert.deepEqual(j.deployments[0], { id: "dpl_1", url: "https://studio-abc.vercel.app", state: "READY", target: "production", created: 1 });
  assert.deepEqual(j.aliases, [{ alias: "getany.org", deployment: "dpl_1" }]);
  assert.ok(seen.every((s) => s.url.includes("teamId=team_42")), seen.map((s) => s.url).join(" "));
  assert.match(seen[1].url, /^\/v7\/deployments\?projectId=prj_1&limit=3&teamId=team_42$/);
});

test("T52: vercel_deploy is outward (ask only); build-release has deploy ask + status allow", async () => {
  assert.equal(CAPABILITIES.vercel_deploy.outward, true);
  assert.ok(!("outward" in CAPABILITIES.vercel_status) || !CAPABILITIES.vercel_status.outward);
  const spec = await loadAgent("build-release");
  assert.equal(spec.tools.vercel_deploy, "ask");
  assert.equal(spec.tools.vercel_status, "allow");
});
