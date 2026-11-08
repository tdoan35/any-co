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

test("gallery: agent-written shapes (path, approve/reject) list, and /file serves art/ + assets/ with confinement", () => {
  const games = mkdtempSync(path.join(tmpdir(), "gallery-shapes-"));
  const repo = path.join(games, "g2");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "art", "gallery", "hero"), { recursive: true });
  mkdirSync(path.join(repo, "assets", "sprites"), { recursive: true });
  writeFileSync(path.join(repo, "art", "gallery", "hero", "c0.png"), "A");
  writeFileSync(path.join(repo, "assets", "sprites", "hero.png"), "B");
  writeFileSync(path.join(games, "secret.png"), "S");
  symlinkSync(path.join(games, "secret.png"), path.join(repo, "assets", "sprites", "leak.png"));
  writeFileSync(path.join(repo, "art", "gallery", "gallery.json"), JSON.stringify({ entries: [
    { asset: "hero", path: "assets/sprites/hero.png", verdict: "approve" },
    { asset: "hero", path: "art/gallery/hero/c0.png", verdict: "reject" },
    { asset: "hero", path: "art/gallery/hero/c0..3.png + x.png", verdict: "reject" },
    { asset: "hero", path: "../secret.png", verdict: "approve" },
    { asset: "hero", path: "assets/sprites/leak.png", verdict: "maybe" },
  ] }));
  const idx = galleryRoute([], games) as { body: { entries: Array<{ file: string; verdict: string; url: string }> } };
  assert.deepEqual(idx.body.entries.map((e) => `${e.file} ${e.verdict}`), ["assets/sprites/hero.png accepted", "art/gallery/hero/c0.png rejected"]);
  const get = (url: string) => galleryRoute(url.replace("/api/art-gallery/", "").split("/").map(decodeURIComponent), games);
  assert.equal(get(idx.body.entries[0].url).png?.toString(), "B");
  assert.equal(get("/api/art-gallery/g2/file/assets/sprites/leak.png").status, 404, "symlink out of assets/ refused");
  assert.equal(get("/api/art-gallery/g2/file/src/main.gd").status, 404, "only art/ and assets/");
});
