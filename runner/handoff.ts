// Upstream file hand-off between cards (T48, AGENTS.md rule 3). A run writes its deliverables into its OWN workspace
// (store/itch-page.md, social/caption-*.txt, …); a dependent card's run starts in a fresh workspace and couldn't read them.
// On close, the dispatcher snapshots the run's produced files into runs/handoff/<card-id>/ (latest run wins); on start, it
// copies each upstream card's snapshot into the new run's workspace at upstream/<card-id>/ and names the files in the task.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Top-level workspace dirs never snapshotted: the game clone (it lives in git), harness contracts, inherited upstream files. */
const EXCLUDED_TOP = new Set(["game", "contracts", "upstream"]);
/** Secrets and keys are never handed on, whatever directory they sit in. */
const SECRET_NAME = /(^|\/)\.env|\.pem$|id_rsa|credentials/i;
const TEXT_EXT = new Set([".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".html"]);
export const HANDOFF_CAPS = { textBytes: 256 * 1024, binaryBytes: 25 * 1024 * 1024, totalBytes: 60 * 1024 * 1024 };
/** submit_result fields whose values name files the run produced (they may sit inside game/, e.g. a trailer render). */
const PATH_KEYS = new Set(["caption_path", "media_path"]);
const LIST_KEYS = new Set(["files", "outputs"]);

export interface HandoffEntry { path: string; bytes: number; sha256?: string; copied: boolean; skipped?: string }
export interface HandoffManifest { card: string; run_id: string; agent: string; ts: string; total_bytes: number; files: HandoffEntry[] }

export const handoffDir = (runsDir: string, cardId: string) => path.join(runsDir, "handoff", cardId);

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** Workspace-relative paths of every regular file under `dir`, skipping excluded top-level dirs. Symlinks are listed (checked later). */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (!rel && EXCLUDED_TOP.has(name)) continue;
    const st = lstatSync(path.join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

/** Paths a run's output names as its products: files[].path, outputs[].path, caption_path, media_path, at any depth. */
export function outputPaths(output: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown, key?: string) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (key && LIST_KEYS.has(key) && x && typeof x === "object" && typeof (x as { path?: unknown }).path === "string") found.push((x as { path: string }).path);
        visit(x);
      }
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (PATH_KEYS.has(k) && typeof x === "string") found.push(x);
        visit(x, k);
      }
    }
  };
  visit(output);
  return [...new Set(found)];
}

/**
 * Snapshot a finished run's produced files for its card: everything in the workspace except game/, contracts/ and upstream/,
 * plus any file the output names (even inside game/). Each file must be a regular file whose realpath stays inside the run's
 * workspace; secret-looking names are skipped; text files ≤ 256 KB, others ≤ 25 MB, ≤ 60 MB per card. A new run of the same
 * card replaces the snapshot. Returns the manifest (also written as manifest.json in the snapshot dir).
 */
export function snapshotRun(runsDir: string, runId: string, cardId: string, agent: string, output: unknown): HandoffManifest {
  const workspace = path.join(runsDir, runId, "workspace");
  const dest = handoffDir(runsDir, cardId);
  rmSync(dest, { recursive: true, force: true }); // latest run wins
  mkdirSync(dest, { recursive: true });
  const manifest: HandoffManifest = { card: cardId, run_id: runId, agent, ts: new Date().toISOString(), total_bytes: 0, files: [] };
  if (!existsSync(workspace)) {
    writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  }
  const realWs = realpathSync(workspace);
  const named = outputPaths(output)
    .map((p) => (path.isAbsolute(p) ? path.relative(workspace, p) : p).replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((p) => p && !p.startsWith("../") && !path.isAbsolute(p));
  const candidates = [...new Set([...walk(workspace), ...named])];
  for (const rel of candidates) {
    const abs = path.join(workspace, rel);
    const skip = (reason: string, bytes = 0) => manifest.files.push({ path: rel, bytes, copied: false, skipped: reason });
    if (SECRET_NAME.test(rel)) { skip("secret-looking name"); continue; }
    if (!existsSync(abs)) { skip("named in the output but not in the workspace"); continue; }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      skip("unreadable");
      continue;
    }
    if (!inside(real, realWs)) { skip("resolves outside the run's workspace (symlink)"); continue; }
    const st = statSync(real);
    if (!st.isFile()) { skip("not a regular file"); continue; }
    const cap = TEXT_EXT.has(path.extname(rel).toLowerCase()) ? HANDOFF_CAPS.textBytes : HANDOFF_CAPS.binaryBytes;
    if (st.size > cap) { skip(`over the ${cap / 1024 >= 1024 ? `${cap / 1024 / 1024} MB` : `${cap / 1024} KB`} per-file cap`, st.size); continue; }
    if (manifest.total_bytes + st.size > HANDOFF_CAPS.totalBytes) { skip("over the 60 MB per-card cap", st.size); continue; }
    const bytes = readFileSync(real);
    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    copyFileSync(real, path.join(dest, rel));
    manifest.total_bytes += st.size;
    manifest.files.push({ path: rel, bytes: st.size, sha256: createHash("sha256").update(bytes).digest("hex"), copied: true });
  }
  writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export interface HandIn { id: string; agent: string; files: string[] }

/** Copy each upstream card's snapshot into the new run's workspace at upstream/<card-id>/; returns what each card handed in. */
export function handIn(runsDir: string, workspace: string, upstream: Array<{ id: string; agent?: string | null }>): HandIn[] {
  const got: HandIn[] = [];
  for (const u of upstream) {
    const src = handoffDir(runsDir, u.id);
    if (!existsSync(path.join(src, "manifest.json"))) continue;
    const m = JSON.parse(readFileSync(path.join(src, "manifest.json"), "utf8")) as HandoffManifest;
    const dest = path.join(workspace, "upstream", u.id);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    got.push({ id: u.id, agent: m.agent || u.agent || "unknown", files: m.files.filter((f) => f.copied).map((f) => f.path).sort() });
  }
  return got;
}

/** The task lines naming the handed-in files (up to 30 per card). */
export function handInLines(got: HandIn[]): string[] {
  return got.map((g) => {
    const shown = g.files.slice(0, 30);
    const more = g.files.length > shown.length ? ` (+${g.files.length - shown.length} more; see upstream/${g.id}/manifest.json)` : "";
    return `files from ${g.id} (${g.agent}): upstream/${g.id}/ — ${shown.length ? shown.join(", ") : "(none)"}${more}`;
  });
}
