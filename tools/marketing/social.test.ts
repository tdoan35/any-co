import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createYoutubeUpload, tiktokUpload, type FetchLike } from "./social.ts";
import type { ToolContext } from "../../runner/tools/kit.ts";

const TOKEN = "refresh-token-should-never-leak";
const ACCESS = "access-token-should-never-leak";
const PHRASE = "Made by an AI-run studio.";

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const setup = () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "anyco-social-"));
  mkdirSync(path.join(workspace, "media"));
  writeFileSync(path.join(workspace, "media", "trailer.mp4"), "not-a-real-video");
  const ctx = { workspace, naive: null, agent: "social-media-manager" } as ToolContext;
  return { workspace, ctx };
};

const json = (content: string) => JSON.parse(content) as Record<string, unknown>;

test("youtube dry-run is the default and never calls the network", async () => {
  const { ctx } = setup();
  const fetchImpl: FetchLike = async () => {
    throw new Error("network");
  };
  const tool = createYoutubeUpload(fetchImpl);
  const out = await tool.run({ file: "media/trailer.mp4", title: "Haul", description: "A clip.", privacy: "unlisted" }, ctx);
  assert.equal(out.is_error, undefined);
  const body = json(out.content);
  assert.equal(body.dry_run, true);
  assert.equal(body.sent, false);
  assert.equal(body.bytes, Buffer.byteLength("not-a-real-video"));
  assert.equal(body.privacy, "unlisted");
  assert.ok(!out.content.includes(TOKEN));
});

test("youtube refuses paths outside media/ before any network", async () => {
  const { workspace, ctx } = setup();
  writeFileSync(path.join(workspace, "secret.mp4"), "x");
  let called = false;
  const tool = createYoutubeUpload(async () => {
    called = true;
    throw new Error("network");
  });
  for (const file of ["../secret.mp4", "secret.mp4", "/etc/passwd", "media/../secret.mp4"]) {
    const out = await tool.run({ file, title: "Haul", description: "A clip." }, ctx);
    assert.equal(out.is_error, true, file);
  }
  symlinkSync(path.join(workspace, "secret.mp4"), path.join(workspace, "media", "link.mp4"));
  const link = await tool.run({ file: "media/link.mp4", title: "Haul", description: "A clip." }, ctx);
  assert.equal(link.is_error, true);
  assert.equal(called, false);
});

test("youtube live upload sends the file and returns only the video id", async () => {
  const { ctx } = setup();
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    assert.ok(!auth.includes(TOKEN));
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: ACCESS }), { status: 200 });
    }
    if (String(url).includes("uploadType=resumable")) {
      assert.ok(auth.includes(ACCESS));
      return new Response("", { status: 200, headers: { location: "https://uploads.example/session" } });
    }
    assert.equal(url, "https://uploads.example/session");
    return new Response(JSON.stringify({ id: "vid123" }), { status: 200 });
  };
  const tool = createYoutubeUpload(fetchImpl);
  await withEnv(
    { YOUTUBE_CLIENT_ID: "cid", YOUTUBE_CLIENT_SECRET: "sec", YOUTUBE_REFRESH_TOKEN: TOKEN, STUDIO_DISCLOSURE: PHRASE },
    async () => {
      const out = await tool.run({ file: "media/trailer.mp4", title: "Haul", description: `Clip. ${PHRASE}`, privacy: "unlisted", dry_run: false }, ctx);
      assert.equal(out.is_error, undefined);
      const body = json(out.content);
      assert.equal(body.sent, true);
      assert.equal(body.video_id, "vid123");
      assert.ok(!out.content.includes(TOKEN));
      assert.ok(!out.content.includes(ACCESS));
    },
  );
  assert.equal(calls.length, 3);
});

test("youtube live upload refuses missing credentials and a missing disclosure, with no network", async () => {
  const { ctx } = setup();
  let called = false;
  const tool = createYoutubeUpload(async () => {
    called = true;
    throw new Error("network");
  });
  await withEnv({ YOUTUBE_CLIENT_ID: undefined, YOUTUBE_CLIENT_SECRET: undefined, YOUTUBE_REFRESH_TOKEN: undefined, STUDIO_DISCLOSURE: PHRASE }, async () => {
    const out = await tool.run({ file: "media/trailer.mp4", title: "Haul", description: `Clip. ${PHRASE}`, dry_run: false }, ctx);
    assert.equal(out.is_error, true);
    assert.match(out.content, /YOUTUBE_CLIENT_ID/);
    assert.ok(!out.content.includes(TOKEN));
  });
  await withEnv({ YOUTUBE_CLIENT_ID: "cid", YOUTUBE_CLIENT_SECRET: "sec", YOUTUBE_REFRESH_TOKEN: TOKEN, STUDIO_DISCLOSURE: PHRASE }, async () => {
    const out = await tool.run({ file: "media/trailer.mp4", title: "Haul", description: "no phrase", dry_run: false }, ctx);
    assert.equal(out.is_error, true);
    assert.match(out.content, /STUDIO_DISCLOSURE/);
  });
  assert.equal(called, false);
});

test("tiktok dry-run packages the file and a live post is refused with no network", async () => {
  const { ctx } = setup();
  const dry = await tiktokUpload.run({ file: "media/trailer.mp4", title: "Haul", description: "A clip." }, ctx);
  assert.equal(dry.is_error, undefined);
  assert.equal(json(dry.content).sent, false);
  assert.equal(json(dry.content).dry_run, true);
  const live = await tiktokUpload.run({ file: "media/trailer.mp4", title: "Haul", description: "A clip.", dry_run: false }, ctx);
  assert.equal(live.is_error, true);
  assert.match(live.content, /refused/);
  assert.equal(json(live.content).sent, false);
});
