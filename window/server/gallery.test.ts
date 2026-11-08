import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { galleryRoute } from "./gallery.ts";

function fixture() {
  const games = mkdtempSync(path.join(tmpdir(), "gallery-route-"));
  const repo = path.join(games, "g1");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "art", "gallery", "hero"), { recursive: true });
  writeFileSync(path.join(repo, "art", "gallery", "hero", "1-pixellab-accepted.png"), Buffer.from("PNGDATA"));
  writeFileSync(path.join(repo, "art", "gallery", "gallery.json"), JSON.stringify({ entries: [] }));
  const secret = path.join(games, "secret.png");
  writeFileSync(secret, "SECRET");
  return { games, repo, secret };
}

test("gallery png: serves a real file inside art/gallery", () => {
  const { games } = fixture();
  const r = galleryRoute(["g1", "png", "gallery", "hero", "1-pixellab-accepted.png"], games);
  assert.equal(r.status, 200);
  assert.equal(r.png?.toString(), "PNGDATA");
});

test("gallery png: a symlink under art/gallery pointing outside art/ is refused", () => {
  const { games, repo, secret } = fixture();
  symlinkSync(secret, path.join(repo, "art", "gallery", "hero", "2-leak.png"));
  const r = galleryRoute(["g1", "png", "gallery", "hero", "2-leak.png"], games);
  assert.equal(r.status, 404);
  assert.equal(r.png, undefined);
});

test("gallery png: a symlinked directory escaping art/ is refused", () => {
  const { games, repo } = fixture();
  const outside = path.join(games, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "x.png"), "OUTSIDE");
  symlinkSync(outside, path.join(repo, "art", "gallery", "linked"));
  const r = galleryRoute(["g1", "png", "gallery", "linked", "x.png"], games);
  assert.equal(r.status, 404);
});

test("gallery png: non-png files are not served", () => {
  const { games, repo } = fixture();
  writeFileSync(path.join(repo, "art", "gallery", "notes.txt"), "hi");
  assert.equal(galleryRoute(["g1", "png", "gallery", "notes.txt"], games).status, 404);
});
