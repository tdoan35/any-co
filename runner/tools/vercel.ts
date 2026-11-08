// vercel_deploy / vercel_status (T52): the studio site on Vercel. The Naïve site host caps files at 2 MB and a Godot
// index.wasm is ~40 MB. Plain REST (docs: vercel.com/docs/rest-api): POST /v2/files (raw bytes, x-vercel-digest = sha1),
// POST /v13/deployments (files by sha, projectSettings.framework null, skipAutoDetectionConfirmation=1), poll
// GET /v13/deployments/:id until READY, optional POST /v2/deployments/:id/aliases. Status: GET /v9/projects/:name,
// GET /v7/deployments?projectId, GET /v4/aliases?projectId.
//
// Token: VERCEL_TOKEN from env only (optional VERCEL_TEAM_ID → ?teamId=). It goes in the Authorization header of
// api.vercel.com calls and nowhere else, and every result and error is redacted. vercel_deploy is outward (an "ask"
// grant: the approval gate + ledger, like itch_push); vercel_status is read-only.
//
// Godot web: the site dir (plus optional mounts of other workspace dirs, e.g. a clone's dist/web at /<slug>/) is
// collected with no symlinks anywhere and hidden entries skipped; vercel.json is merged so every dir holding a .wasm
// gets COOP same-origin + COEP require-corp, *.wasm gets Content-Type application/wasm, and trailingSlash is on (Godot's
// index.html loads index.js relatively, so /slug without the slash would 404 its engine).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { clip, errText, resolveInWorkspace, type ToolContext, type ToolImpl, type ToolOutput } from "./kit.ts";

export const VERCEL_DEFAULT_BASE = "https://api.vercel.com";
/** Vercel documents 100 MB (Hobby) / 1 GB (Pro) of source files for CLI deploys and no smaller per-file cap for static
 *  files; defaults refuse a single file over 100 MB and a deploy over 1 GB before any request. */
export const VERCEL_DEFAULT_MAX_FILE_MB = 100;
export const VERCEL_DEFAULT_MAX_TOTAL_MB = 1024;
const HOBBY_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5000;
/** Poll pacing (tests shrink it). */
export const VERCEL_POLL = { firstMs: 2000, maxMs: 8000, timeoutMs: 15 * 60_000 };
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MOUNT_AT = /^[a-z0-9][a-z0-9_-]{0,62}(\/[a-z0-9][a-z0-9_-]{0,62}){0,3}$/;

const mb = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};
const base = () => (process.env.VERCEL_API_BASE_URL || VERCEL_DEFAULT_BASE).replace(/\/+$/, "");
const token = () => process.env.VERCEL_TOKEN?.trim() || "";

export function redact(s: string): string {
  const t = token();
  let out = t ? s.split(t).join("[redacted]") : s;
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g, "Bearer [redacted]");
  return out;
}
const fail = (msg: string): ToolOutput => ({ content: clip(redact(msg), 6000), is_error: true });
const ok = (data: unknown): ToolOutput => ({ content: clip(redact(JSON.stringify(data, null, 2))) });
const noToken = () => fail("VERCEL_TOKEN is not set in the studio's environment; the operator provides it in env only (no request was made).");

class VercelError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly data: any) {
    super(message);
  }
}

function withTeam(p: string): string {
  const team = process.env.VERCEL_TEAM_ID?.trim();
  return team ? `${p}${p.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(team)}` : p;
}

async function api(method: "GET" | "POST", p: string, opts: { json?: unknown; bytes?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token()}`, ...(opts.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (opts.bytes) {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(opts.bytes.length);
    body = new Uint8Array(opts.bytes);
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(base() + withTeam(p), { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  const raw = await res.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw: raw.slice(0, 200) };
  }
  if (!res.ok) {
    const code = data?.error?.code;
    throw new VercelError(res.status, code, `Vercel ${method} ${p.split("?")[0]} failed (${res.status}${code ? ` ${code}` : ""}): ${data?.error?.message ?? data?.raw ?? "no message"}`, data);
  }
  return data;
}

// ---------- collecting the site ----------
export interface SiteFile { file: string; abs: string; sha: string; size: number }

/** Walk a dir: no symlinks anywhere (refused, never followed), hidden entries skipped (.env, .git, .DS_Store). */
async function walk(abs: string, prefix: string, out: Map<string, SiteFile>, skipped: string[]): Promise<void> {
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isSymbolicLink()) throw new Error(`${rel} is a symlink; vercel_deploy publishes real files only (no request was made)`);
    if (e.name.startsWith(".")) {
      skipped.push(rel);
      continue;
    }
    const p = path.join(abs, e.name);
    if (e.isDirectory()) await walk(p, rel + "/", out, skipped);
    else if (e.isFile()) {
      if (out.size >= MAX_FILES) throw new Error(`vercel_deploy tops out at ${MAX_FILES} files (no request was made)`);
      const st = lstatSync(p);
      out.set(rel, { file: rel, abs: p, sha: "", size: st.size });
    }
  }
}

/** A dir strictly inside the run workspace by realpath (never the workspace root), with no symlink on the way. */
function realDirInWorkspace(ctx: ToolContext, rel: string, label: string): string {
  const abs = resolveInWorkspace(ctx.workspace, rel);
  if (!existsSync(abs)) throw new Error(`${label} "${rel}" does not exist in your workspace (no request was made)`);
  if (lstatSync(abs).isSymbolicLink()) throw new Error(`${label} "${rel}" is a symlink (no request was made)`);
  const wsReal = realpathSync(ctx.workspace);
  const real = realpathSync(abs);
  if (real === wsReal || !real.startsWith(wsReal + path.sep)) throw new Error(`${label} "${rel}" must be a directory strictly inside your workspace (no request was made)`);
  if (!lstatSync(real).isDirectory()) throw new Error(`${label} "${rel}" is not a directory (no request was made)`);
  return real;
}

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

/** Merge the Godot web rules into an existing vercel.json (theirs kept; ours added where the same source+key is absent). */
export function mergeVercelJson(existing: Record<string, any> | null, wasmDirs: string[]): Record<string, any> {
  const cfg: Record<string, any> = existing ? structuredClone(existing) : {};
  const rules: Rule[] = Array.isArray(cfg.headers) ? cfg.headers : [];
  const add = (source: string, headers: Header[]) => {
    let rule = rules.find((r) => r.source === source);
    if (!rule) rules.push((rule = { source, headers: [] }));
    for (const h of headers) if (!rule.headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())) rule.headers.push(h);
  };
  const isolation: Header[] = [
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  ];
  for (const d of [...new Set(wasmDirs)].sort()) {
    if (d === "") add("/(.*)", isolation);
    else {
      add(`/${d}`, isolation);
      add(`/${d}/(.*)`, isolation);
    }
  }
  add("/(.*).wasm", [{ key: "Content-Type", value: "application/wasm" }]);
  cfg.headers = rules;
  if (cfg.trailingSlash === undefined) cfg.trailingSlash = true;
  return cfg;
}

async function collectSite(ctx: ToolContext, dir: string, mounts: Array<{ path: string; at: string }>) {
  const files = new Map<string, SiteFile>();
  const skipped: string[] = [];
  const rootReal = realDirInWorkspace(ctx, dir, "dir");
  await walk(rootReal, "", files, skipped);
  for (const m of mounts) {
    if (files.has(m.at) || [...files.keys()].some((f) => f.startsWith(m.at + "/"))) throw new Error(`mount at "${m.at}" collides with files already in the site (no request was made)`);
    const real = realDirInWorkspace(ctx, m.path, "mount");
    await walk(real, m.at + "/", files, skipped);
  }
  return { rootReal, files, skipped };
}

// ---------- tools ----------
const deployInput = z
  .object({
    dir: z.string().min(1).max(200).describe("Static site dir inside your workspace, e.g. 'site' (its index.html is /)"),
    mounts: z
      .array(z.object({ path: z.string().min(1).max(200).describe("Workspace dir, e.g. 'game/dist/web'"), at: z.string().regex(MOUNT_AT).describe("URL path it is served at, e.g. 'caravan-cargo-cult'") }).strict())
      .max(8)
      .default([])
      .describe("Other workspace dirs served under a path (a game's web export at /<slug>/)"),
    project: z.string().regex(PROJECT).describe("Vercel project name, lowercase"),
    production: z.boolean().describe("true deploys to production (the project's production domains); false is a preview URL"),
    alias: z.string().regex(DOMAIN).optional().describe("Optional domain to point at this deployment, e.g. 'getany.org' (must already be on the project)"),
  })
  .strict();
type DeployInput = z.infer<typeof deployInput>;

const TERMINAL = new Set(["READY", "ERROR", "CANCELED", "BLOCKED"]);

const vercelDeploy: ToolImpl = {
  description:
    "Deploy a static site from your workspace to Vercel (the studio site; Godot web builds need it: no 2 MB file cap). dir is the site root; " +
    "mounts serve other workspace dirs under a path (e.g. game/dist/web at /<slug>/). Writes/merges vercel.json (COOP/COEP on every dir with " +
    "a .wasm, application/wasm, trailing slashes). No symlinks; hidden files are skipped. Every call needs the operator's approval.",
  input: deployInput,
  async run(i: DeployInput, ctx: ToolContext) {
    if (!token()) return noToken();
    let site: Awaited<ReturnType<typeof collectSite>>;
    const maxFile = mb(process.env.VERCEL_MAX_FILE_MB, VERCEL_DEFAULT_MAX_FILE_MB) * 1024 * 1024;
    const maxTotal = mb(process.env.VERCEL_MAX_TOTAL_MB, VERCEL_DEFAULT_MAX_TOTAL_MB) * 1024 * 1024;
    let vercelJson: Record<string, any>;
    try {
      site = await collectSite(ctx, i.dir, i.mounts);
      if (!site.files.has("index.html")) throw new Error(`${i.dir}/index.html is missing: the site needs a home page at / (no request was made)`);
      const over = [...site.files.values()].filter((f) => f.file !== "vercel.json" && f.size > maxFile);
      if (over.length)
        throw new Error(`${over.map((f) => `${f.file} (${(f.size / 1048576).toFixed(1)} MB)`).join(", ")} over the ${(maxFile / 1048576).toFixed(0)} MB per-file limit (VERCEL_MAX_FILE_MB) (no request was made)`);
      const wasmDirs = [...site.files.keys()].filter((f) => f.endsWith(".wasm")).map((f) => path.posix.dirname(f)).map((d) => (d === "." ? "" : d));
      let existing: Record<string, any> | null = null;
      const vj = path.join(site.rootReal, "vercel.json");
      if (existsSync(vj)) {
        try {
          existing = JSON.parse(await readFile(vj, "utf8"));
        } catch (e) {
          throw new Error(`${i.dir}/vercel.json is not valid JSON (${errText(e)}) (no request was made)`);
        }
      }
      vercelJson = mergeVercelJson(existing, wasmDirs);
      await writeFile(vj, JSON.stringify(vercelJson, null, 2) + "\n"); // the merged config is part of the deployed dir
      site.files.set("vercel.json", { file: "vercel.json", abs: vj, sha: "", size: 0 });
      let total = 0;
      for (const f of site.files.values()) {
        const bytes = await readFile(f.abs);
        f.sha = createHash("sha1").update(bytes).digest("hex");
        f.size = bytes.length;
        total += f.size;
      }
      if (total > maxTotal) throw new Error(`the site is ${(total / 1048576).toFixed(1)} MB, over VERCEL_MAX_TOTAL_MB ${(maxTotal / 1048576).toFixed(0)} (no request was made)`);
    } catch (e) {
      return fail(errText(e));
    }
    const list = [...site.files.values()].sort((a, b) => a.file.localeCompare(b.file));
    const total = list.reduce((s, f) => s + f.size, 0);
    try {
      // upload each distinct blob once (an already-uploaded sha answers 200; re-uploading is not an error)
      const bySha = new Map(list.map((f) => [f.sha, f]));
      const upload = async (f: SiteFile) => {
        await api("POST", "/v2/files", { bytes: await readFile(f.abs), headers: { "x-vercel-digest": f.sha }, timeoutMs: 600_000 });
      };
      const queue = [...bySha.values()];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) await upload(f);
      }));
      const body = {
        name: i.project, // the project by name; a first deploy creates it (projectSettings are saved then). Not `project`: that must already exist
        files: list.map((f) => ({ file: f.file, sha: f.sha, size: f.size })),
        ...(i.production ? { target: "production" } : {}),
        projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
      };
      let dep: any;
      try {
        dep = await api("POST", "/v13/deployments?skipAutoDetectionConfirmation=1", { json: body });
      } catch (e) {
        // Vercel answers missing_files with the shas it lacks: upload those and create once more
        const missing: string[] = e instanceof VercelError && e.code === "missing_files" ? e.data?.error?.missing ?? [] : [];
        if (!missing.length) throw e;
        for (const sha of missing) {
          const f = bySha.get(sha);
          if (f) await upload(f);
        }
        dep = await api("POST", "/v13/deployments?skipAutoDetectionConfirmation=1", { json: body });
      }
      const deadline = Date.now() + VERCEL_POLL.timeoutMs;
      let delay = VERCEL_POLL.firstMs;
      while (!TERMINAL.has(dep.readyState) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, VERCEL_POLL.maxMs);
        dep = await api("GET", `/v13/deployments/${encodeURIComponent(dep.id)}`);
      }
      let alias: unknown = null;
      if (i.alias && dep.readyState === "READY") {
        try {
          const a = await api("POST", `/v2/deployments/${encodeURIComponent(dep.id)}/aliases`, { json: { alias: i.alias } });
          alias = { ok: true, alias: a.alias, old_deployment: a.oldDeploymentId ?? null };
        } catch (e) {
          alias = { ok: false, alias: i.alias, error: errText(e), hint: "the domain must be added to the project and verified first (Vercel dashboard or POST /v10/projects/:name/domains)" };
        }
      }
      const ready = dep.readyState === "READY";
      const out = {
        ready,
        ready_state: dep.readyState,
        id: dep.id,
        url: dep.url ? `https://${dep.url}` : null,
        project: i.project,
        target: dep.target ?? (i.production ? "production" : "preview"),
        aliases: dep.alias ?? [],
        alias_assigned: dep.aliasAssigned ?? null,
        alias_error: dep.aliasError ?? null,
        alias,
        files: list.length,
        bytes: total,
        largest: list.reduce((m, f) => (f.size > m.size ? f : m), list[0]).file,
        skipped_hidden: site.skipped,
        vercel_json: vercelJson,
        ...(total > HOBBY_TOTAL_BYTES ? { warning: `${(total / 1048576).toFixed(1)} MB is over Vercel's documented 100 MB Hobby source limit; a Pro team allows 1 GB` } : {}),
        ...(ready ? {} : { error: dep.errorMessage ?? `deployment ended ${dep.readyState ?? "unknown"} (or timed out polling)` }),
      };
      return ready ? ok(out) : { ...ok(out), is_error: true };
    } catch (e) {
      return fail(errText(e));
    }
  },
};

const vercelStatus: ToolImpl = {
  description: "Read-only: a Vercel project's latest deployments (url, state, target) and its aliases/domains. No upload, not gated.",
  input: z.object({ project: z.string().regex(PROJECT), limit: z.number().int().min(1).max(20).default(5) }).strict(),
  async run({ project, limit }) {
    if (!token()) return noToken();
    try {
      const p = await api("GET", `/v9/projects/${encodeURIComponent(project)}`);
      const deps = await api("GET", `/v7/deployments?projectId=${encodeURIComponent(p.id)}&limit=${limit}`);
      let aliases: any = null;
      try {
        aliases = await api("GET", `/v4/aliases?projectId=${encodeURIComponent(p.id)}&limit=20`);
      } catch (e) {
        aliases = { error: errText(e) };
      }
      return ok({
        project: { id: p.id, name: p.name, framework: p.framework ?? null },
        production_domains: (p.targets?.production?.alias ?? p.alias?.map?.((a: any) => a.domain) ?? []),
        deployments: (deps.deployments ?? []).map((d: any) => ({ id: d.uid ?? d.id, url: d.url ? `https://${d.url}` : null, state: d.state ?? d.readyState, target: d.target ?? null, created: d.created ?? d.createdAt ?? null })),
        aliases: Array.isArray(aliases?.aliases) ? aliases.aliases.map((a: any) => ({ alias: a.alias, deployment: a.deploymentId ?? null })) : aliases,
      });
    } catch (e) {
      return fail(errText(e));
    }
  },
};

export const vercelDeployTools: Record<string, ToolImpl> = { vercel_deploy: vercelDeploy };
export const vercelStatusTools: Record<string, ToolImpl> = { vercel_status: vercelStatus };
