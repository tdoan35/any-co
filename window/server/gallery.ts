// Art gallery endpoints (T18): GET /api/art-gallery lists every kept candidate and contact sheet
// from the studio game repo(s)' art/gallery/gallery.json; GET /api/art-gallery/png/<repo>/<..>
// serves one PNG. Read-only, localhost/Electron origins only (the same gate as every route).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ArtGalleryEntry } from "@fabric/contracts";

interface GalleryIndexFile {
  entries?: Array<{
    asset?: string; file?: string; path?: string; provider?: string;
    verdict?: string; reason?: string; gate?: Record<string, unknown> | null; run_id?: string; ts?: string;
  }>;
}

/** Every game repo under gamesRoot that has a gallery index. */
function galleryRepos(gamesRoot: string): string[] {
  if (!existsSync(gamesRoot)) return [];
  return readdirSync(gamesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(gamesRoot, e.name, "art", "gallery", "gallery.json")))
    .map((e) => e.name)
    .sort();
}

/** Repo-relative path inside art/gallery/, or null: no `..` escapes, no absolute paths. */
function galleryRel(rest: string[]): string | null {
  if (!rest.length) return null;
  const rel = path.posix.normalize(rest.join("/"));
  if (path.isAbsolute(rel) || rel.split("/").includes("..")) return null;
  if (!rel.startsWith("gallery/") && rel !== "gallery") return null;
  return rel;
}

export function galleryRoute(seg: string[], gamesRoot: string): { status: number; body: unknown; png?: Buffer } {
  const missing = { status: 404, body: { error: "not found" } } as const;
  const repos = galleryRepos(gamesRoot);
    const repo = seg[0];
  if (!repo) {
    // index of repos → entries, asset ids resolved from the path art/gallery/<asset>/..
    const all = repos.flatMap((name) => entriesOf(path.join(gamesRoot, name), name));
    return { status: 200, body: { repos, entries: all } };
  }
  if (!repos.includes(repo)) return { ...missing };
  const root = path.join(gamesRoot, repo);
  if (seg[1] === "png") {
    const rel = galleryRel(seg.slice(2));
    if (!rel) return { ...missing };
    const file = path.join(root, "art", rel);
    if (!/\.png$/i.test(rel) || !existsSync(file)) return { ...missing };
    // realpath, not path.resolve: agents commit to the game repo, and a symlink under art/gallery must not serve
    // anything outside the repo's real art/ directory (e.g. a link to the harness .env).
    let realFile: string;
    let realRoot: string;
    try {
      realRoot = realpathSync(path.join(root, "art"));
      realFile = realpathSync(file);
    } catch {
      return { ...missing };
    }
    if (!realFile.startsWith(realRoot + path.sep) || !statSync(realFile).isFile()) return { ...missing };
    return { status: 200, body: null, png: readFileSync(realFile) };
  }
  if (seg[1] === "file") {
    // repo-relative image under art/ or assets/ (realpath-confined to that dir: a symlink can't serve anything outside it)
    const rel = path.posix.normalize(seg.slice(2).join("/"));
    const top = rel.split("/")[0];
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..") || !/\.png$/i.test(rel) || (top !== "art" && top !== "assets")) return { ...missing };
    let realFile: string;
    let realRoot: string;
    try {
      realRoot = realpathSync(path.join(root, top));
      realFile = realpathSync(path.join(root, rel));
    } catch {
      return { ...missing };
    }
    if (!realFile.startsWith(realRoot + path.sep) || !statSync(realFile).isFile()) return { ...missing };
    return { status: 200, body: null, png: readFileSync(realFile) };
  }
  if (seg[1]) return { ...missing };
  return { status: 200, body: { repo, entries: entriesOf(root, repo) } };
}

/** Normalize an agent-written verdict word: agents wrote approve/accept/accepted and reject/rejected. */
function verdictOf(v: unknown): "accepted" | "rejected" | null {
  const w = String(v ?? "").toLowerCase();
  if (["accepted", "accept", "approve", "approved", "pass", "passed"].includes(w)) return "accepted";
  if (["rejected", "reject", "denied", "fail", "failed"].includes(w)) return "rejected";
  return null;
}

/**
 * A gallery entry's image as a repo-relative path. Older entries name `file` relative to art/ ("gallery/x/1.png"); agents
 * since wrote `path` relative to the repo ("art/gallery/x/1.png" or "assets/sprites/x.png"). Only a single .png that exists
 * under art/ or assets/ counts (patterns like "a-0..3.png + b.png" are skipped).
 */
function imagePathOf(repoRoot: string, e: { file?: string; path?: string }): string | null {
  const cand = typeof e.file === "string" ? `art/${e.file}` : typeof e.path === "string" ? e.path : null;
  if (!cand) return null;
  const rel = path.posix.normalize(cand);
  if (path.isAbsolute(rel) || rel.split("/").includes("..") || !/\.png$/i.test(rel) || !/^(art|assets)\//.test(rel)) return null;
  return existsSync(path.join(repoRoot, rel)) ? rel : null;
}

function entriesOf(repoRoot: string, repo: string): ArtGalleryEntry[] {
  let parsed: GalleryIndexFile;
  try {
    parsed = JSON.parse(readFileSync(path.join(repoRoot, "art", "gallery", "gallery.json"), "utf8")) as GalleryIndexFile;
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
  return raw.flatMap((e) => {
    const verdict = verdictOf(e.verdict);
    const rel = typeof e.asset === "string" && verdict ? imagePathOf(repoRoot, e as { file?: string; path?: string }) : null;
    if (!rel || !verdict) return [];
    return [{
      asset: e.asset!,
      file: rel,
      url: `/api/art-gallery/${repo}/file/${rel.split("/").map(encodeURIComponent).join("/")}`,
      provider: e.provider ?? "unknown",
      verdict,
      reason: e.reason ?? "",
      gate: (e.gate ?? null) as ArtGalleryEntry["gate"],
      runId: e.run_id ?? "unknown",
      ts: e.ts ?? "",
    }];
  });
}
