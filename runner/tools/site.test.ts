import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";
import type { NaiveClient } from "../../runner/providers.ts";

const BID = "20261107-2140-abc1234";

interface DeployCall { appId: string; files: Record<string, string>; contentHash?: string }
interface AppDeploymentLike { id: string; status: string; url: string | null; created_at?: string }

interface FakeCalls {
  deploy: DeployCall[];
  redeploys: Array<{ appId: string; from: string }>;
  statusCalls: number;
}

// A fake SDK apps client shaped like the real one (deploy takes path -> base64 contents).
const fakeNaive = (calls: FakeCalls): NaiveClient =>
  ({
    apps: {
      deploy: async (appId: string, files: Record<string, string>, contentHash?: string) => {
        calls.deploy.push({ appId, files, contentHash });
        return { id: "apd_new", object: "app_deployment", app_id: appId, status: "queued", url: null, error: null, content_hash: contentHash ?? null, created_at: "t" };
      },
      redeploy: async (appId: string, from: string) => {
        calls.redeploys.push({ appId, from });
        return { id: "apd_rolled", object: "app_deployment", app_id: appId, status: "queued", url: null, error: null, content_hash: null, created_at: "t" };
      },
      get: async (_appId: string) => ({ id: "app_1", object: "app", name: "studio-site", description: null, type: "frontend_only", project: null, status: "active", url: "https://studio-site.anyco.app", error: null, mcp: null, dashboard: false, created_at: "t" }),
      deployments: async (_appId: string, q?: { limit?: number }) => {
        const mk = (id: string): AppDeploymentLike => ({ id, status: "ready", url: "https://studio-site.anyco.app", created_at: "t" });
        return { data: [mk("apd_1"), mk("apd_2")].slice(0, q?.limit ?? 5), has_more: false, next_cursor: null };
      },
      deploymentFiles: async (_appId: string, deploymentId: string) => ({
        object: "app_deployment_files", deployment_id: deploymentId,
        files: { "build_id.txt": Buffer.from(`${BID}\n`).toString("base64"), "index.html": Buffer.from("<h1>hi</h1>").toString("base64") },
      }),
    },
  }) as unknown as NaiveClient;

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const setup = () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "anyco-site-"));
  const clone = path.join(workspace, "game");
  mkdirSync(path.join(clone, "dist", "web"), { recursive: true });
  writeFileSync(path.join(clone, "dist", "build_id"), `${BID}\n`);
  writeFileSync(path.join(clone, "dist", "web", "index.html"), "<h1>play me</h1>");
  writeFileSync(path.join(clone, "dist", "web", "game.js"), "console.log(1)");
  writeFileSync(path.join(clone, "dist", "web", ".hidden.txt"), "dot");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  writeFileSync(path.join(clone, "dist", "web", "icon.png"), png);
  mkdirSync(path.join(clone, "site"), { recursive: true });
  writeFileSync(path.join(clone, "site", "landing.md"), "# landing");
  writeFileSync(path.join(clone, "site", "devlog.md"), "# devlog");
  return { workspace, png, ctx: { workspace, naive: null, agent: "build-release" } as ToolContext };
};
const decode = (b64: string) => Buffer.from(b64, "base64");

const deploy = (ctx: ToolContext, naive: NaiveClient, input: Record<string, unknown> = {}) =>
  IMPLS.site_deploy.site_deploy.run(input, { ...ctx, naive });

test("site_deploy uploads the web dir + site/ as base64, records build_id, skips dotfiles", async () => {
  const { ctx, png } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    const out = await deploy(ctx, fakeNaive(calls));
    assert.equal(out.is_error, undefined);
    assert.equal(calls.deploy.length, 1);
    const { appId, files, contentHash } = calls.deploy[0];
    assert.equal(appId, "app_1");
    assert.deepEqual(Object.keys(files).sort(), ["build_id.txt", "game.js", "icon.png", "index.html", "site/devlog.md", "site/landing.md"]);
    assert.equal(decode(files["index.html"]).toString("utf8"), "<h1>play me</h1>");
    assert.deepEqual(decode(files["icon.png"]), png); // binary round-trips via base64
    assert.equal(decode(files["build_id.txt"]).toString("utf8").trim(), BID);
    assert.ok(contentHash && contentHash.length > 0, "content_hash computed so unchanged sites can be skipped");
    const r = JSON.parse(out.content);
    assert.equal(r.build_id, BID);
    assert.equal(r.deployment, "apd_new");
    assert.equal(r.app_url, "https://studio-site.anyco.app");
  });
});

test("site_deploy: include_hidden ships dotfiles too", async () => {
  const { ctx } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    await deploy(ctx, fakeNaive(calls), { include_hidden: true });
    assert.ok(calls.deploy[0].files[".hidden.txt"], "dotfile included on request");
  });
});

test("site_deploy: dir cannot escape the clone; build_id is required and named when missing", async () => {
  const { ctx } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    const escape = await deploy(ctx, fakeNaive(calls), { dir: ".." });
    assert.equal(escape.is_error, true);
    assert.equal(calls.deploy.length, 0);
  });
  const bare = mkdtempSync(path.join(tmpdir(), "anyco-site-bare-"));
  mkdirSync(path.join(bare, "game", "dist", "web"), { recursive: true });
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    const out = await deploy({ workspace: bare, naive: null, agent: "build-release" } as ToolContext, fakeNaive(calls));
    assert.equal(out.is_error, true);
    assert.match(out.content, /dist\/build_id/);
    assert.equal(calls.deploy.length, 0);
  });
});

test("site_deploy: missing app id names what is missing and how to fix it", async () => {
  const { ctx } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: undefined }, async () => {
    const out = await deploy(ctx, fakeNaive(calls));
    assert.equal(out.is_error, true);
    assert.match(out.content, /STUDIO_SITE_APP_ID/);
    assert.match(out.content, /create/);
    assert.equal(calls.deploy.length, 0);
  });
});

test("site_deploy: rollback_to redeploys an earlier deployment without uploading", async () => {
  const { ctx } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    const out = await deploy(ctx, fakeNaive(calls), { rollback_to: "apd_1" });
    assert.equal(out.is_error, undefined);
    assert.equal(calls.deploy.length, 0);
    assert.deepEqual(calls.redeploys, [{ appId: "app_1", from: "apd_1" }]);
    const r = JSON.parse(out.content);
    assert.equal(r.deployment, "apd_rolled");
    assert.equal(r.rolled_back_to, "apd_1");
  });
});

test("site_status: app url + last 5 deployments + latest build_id", async () => {
  const { ctx } = setup();
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    const out = await IMPLS.site_status.site_status.run({}, { ...ctx, naive: fakeNaive(calls) });
    assert.equal(out.is_error, undefined);
    const r = JSON.parse(out.content);
    assert.equal(r.app.url, "https://studio-site.anyco.app");
    assert.equal(r.build_id, BID);
    assert.equal(r.deployments.length, 2);
    assert.equal(r.deployments[0].id, "apd_1");
  });
});

test("site_deploy refuses a web dir symlinked out of the clone, symlinks inside the tree, and the clone root (nothing deployed)", async () => {
  const { symlinkSync, rmSync } = await import("node:fs");
  const calls: FakeCalls = { deploy: [], redeploys: [], statusCalls: 0 };
  await withEnv({ STUDIO_SITE_APP_ID: "app_1" }, async () => {
    // 1. dist/web -> a directory outside the clone (the R4 itch_push hole)
    const a = setup();
    const outside = mkdtempSync(path.join(tmpdir(), "anyco-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "not for the public site");
    const web = path.join(a.workspace, "game", "dist", "web");
    rmSync(web, { recursive: true });
    symlinkSync(outside, web);
    const r1 = await deploy(a.ctx, fakeNaive(calls));
    assert.equal(r1.is_error, true);
    assert.match(String(r1.content), /strictly inside your clone/);
    // 2. a symlink inside the tree
    const b = setup();
    symlinkSync(outside, path.join(b.workspace, "game", "dist", "web", "linked"));
    const r2 = await deploy(b.ctx, fakeNaive(calls));
    assert.equal(r2.is_error, true);
    assert.match(String(r2.content), /symlink/);
    // 3. the clone root itself
    const c = setup();
    const r3 = await deploy(c.ctx, fakeNaive(calls), { dir: "." });
    assert.equal(r3.is_error, true);
    assert.equal(calls.deploy.length, 0, "nothing reached apps.deploy");
  });
});
