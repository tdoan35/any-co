// Art gallery endpoints (T18): GET /api/art-gallery lists every kept candidate and contact sheet
// from the studio game repo(s)' art/gallery/gallery.json; GET /api/art-gallery/png/<repo>/<..>
// serves one PNG. Read-only, localhost/Electron origins only (the same gate as every route).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ArtGalleryEntry } from "@fabric/contracts";

interface GalleryIndexFile {
  entries?: Array<{
    asset?: string; file?: string; provider?: string;
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
    const realRoot = path.resolve(root, "art");
    const realFile = path.resolve(file);
    if (!realFile.startsWith(realRoot + path.sep) || !existsSync(file) || !statSync(file).isFile()) return { ...missing };
    return { status: 200, body: null, png: readFileSync(file) };
  }
  if (seg[1]) return { ...missing };
  return { status: 200, body: { repo, entries: entriesOf(root, repo) } };
}

function entriesOf(repoRoot: string, repo: string): ArtGalleryEntry[] {
  let parsed: GalleryIndexFile;
  try {
    parsed = JSON.parse(readFileSync(path.join(repoRoot, "art", "gallery", "gallery.json"), "utf8")) as GalleryIndexFile;
  } catch {
    return [];
  }
  return (parsed.entries ?? [])
    .filter((e) => typeof e.file === "string" && typeof e.asset === "string" && (e.verdict === "accepted" || e.verdict === "rejected"))
    .map((e) => ({
      asset: e.asset!,
      file: e.file!,
      url: `/api/art-gallery/${repo}/png/${e.file!.split("/").map(encodeURIComponent).join("/")}`,
      provider: e.provider ?? "unknown",
      verdict: e.verdict as "accepted" | "rejected",
      reason: e.reason ?? "",
      gate: (e.gate ?? null) as ArtGalleryEntry["gate"],
      runId: e.run_id ?? "unknown",
      ts: e.ts ?? "",
    }));
}
