// Adapter: serves the Fabric UI's HTTP contract (window/packages/contracts) from this repo's runs/ and agents/.
// Read-only except chat: POST /api/sessions and POST /api/sessions/:id/messages talk to the Studio Head
// (chat.ts). Run: `npm run window:server` (port 8787, PORT to change).
// Only the window's own origins may call it (localhost, the Electron app); a web page you happen to visit may not.
import http from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CreateSessionRequestSchema, PostMessageRequestSchema, encodeFrame, type AppEvent } from "@fabric/contracts";
import { loadAllAgents, ROOT } from "../../runner/load.ts";
import type { AgentSpec } from "../../runner/spec.ts";
import { naiveClient, providerFor, type NaiveClient } from "../../runner/providers.ts";
import type { Provider } from "../../runner/types.ts";
import { ChatEngine, ChatError } from "./chat.ts";
import { boardFromEnv } from "../../runner/board/index.ts";
import type { Board } from "../../runner/board/index.ts";
import { buildRegistry, PROJECT } from "./registry.ts";
import { galleryRoute } from "./gallery.ts";
import { mapRun, parseTranscript, type MappedRun } from "./runs.ts";
import { buildWeave } from "./weave.ts";

export interface ServerOptions {
  runsDir?: string; agentsDir?: string; port?: number; host?: string;
  /** Studio game repo root (games/): the art gallery is served from the repo(s) under it. */
  gamesRoot?: string;
  /** Tests inject a fake provider; default builds the real one from the agent spec and NAIVE_API_KEY. */
  providerFor?: (spec: AgentSpec) => Provider;
  ledgerFile?: string; eventStart?: string; now?: () => Date;
  /** Approvals queue read by weave items; defaults to approvals.jsonl inside runsDir (STUDIO_APPROVALS_FILE wins). */
  approvalsFile?: string;
  /** Refuse chat writes (403). Default: STUDIO_WINDOW_READONLY=1, or STUDIO_RUNS_DIR pointing outside this repo's runs/
   *  (a mirror: rsync --delete drops writes, and a chat turn would spend the viewer's key into a ledger copy). */
  readOnly?: boolean;
  /** The studio board shared by chat turns and the weave view; defaults to boardFromEnv (STUDIO_BOARD*). */
  board?: Board;
}

const EXTRA_ORIGINS = (process.env.WINDOW_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** No Origin header = not a browser (curl, tests). Browsers must come from localhost or the Electron app. */
export const originAllowed = (origin: string | undefined) =>
  origin === undefined || origin === "app://fabric" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || EXTRA_ORIGINS.includes(origin);

const readJson = (req: http.IncomingMessage, max = 100_000) =>
  new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new ChatError(413, "body too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new ChatError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });

/** The runs dir a window reads: opts, then STUDIO_RUNS_DIR (relative to the repo root), then <repo>/runs. */
export function windowRunsDir(opts: Pick<ServerOptions, "runsDir"> = {}, env: NodeJS.ProcessEnv = process.env): { runsDir: string; fromEnv: boolean } {
  if (opts.runsDir) return { runsDir: opts.runsDir, fromEnv: false };
  if (env.STUDIO_RUNS_DIR) return { runsDir: path.resolve(ROOT, env.STUDIO_RUNS_DIR), fromEnv: true };
  return { runsDir: path.join(ROOT, "runs"), fromEnv: false };
}

/** Read-only when asked (opts / STUDIO_WINDOW_READONLY=1) or implied by an env runs dir outside this repo's runs/. */
export function windowReadOnly(opts: Pick<ServerOptions, "readOnly">, runsDir: string, fromEnv: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (opts.readOnly !== undefined) return opts.readOnly;
  if (env.STUDIO_WINDOW_READONLY === "1") return true;
  const own = path.join(ROOT, "runs");
  return fromEnv && path.resolve(runsDir) !== own && !path.resolve(runsDir).startsWith(own + path.sep);
}

export async function startServer(opts: ServerOptions = {}) {
  const { runsDir, fromEnv } = windowRunsDir(opts);
  const readOnly = windowReadOnly(opts, runsDir, fromEnv);
  const gamesRoot = opts.gamesRoot ?? process.env.STUDIO_GAMES_DIR ?? path.join(ROOT, "games");
  const approvalsFile = opts.approvalsFile ?? process.env.STUDIO_APPROVALS_FILE ?? path.join(runsDir, "approvals.jsonl");
  const { ok: specs, errors } = await loadAllAgents(opts.agentsDir);
  for (const e of errors) console.warn(`[window] skipping agent spec: ${e.message}`);
  const deptOf = (agent: string) => specs.find((s: AgentSpec) => s.name === agent)?.dept ?? "ops";

  // Re-parse a transcript only when its size or mtime changed.
  const cache = new Map<string, { key: string; lines: ReturnType<typeof parseTranscript> }>();
  const linesOf = (id: string) => {
    const file = path.join(runsDir, id, "transcript.jsonl");
    if (!existsSync(file)) return undefined;
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(id);
    if (hit?.key === key) return hit.lines;
    const lines = parseTranscript(readFileSync(file, "utf8"));
    cache.set(id, { key, lines });
    return lines;
  };
  const allRuns = (): MappedRun[] => {
    if (!existsSync(runsDir)) return [];
    const out: MappedRun[] = [];
    for (const d of readdirSync(runsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const lines = linesOf(d.name);
      const mapped = lines && mapRun(d.name, lines, deptOf);
      if (mapped) out.push(mapped);
    }
    return out.sort((a, b) => Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt));
  };

  const clients = new Set<http.ServerResponse>();
  const emit = (e: AppEvent) => { for (const c of clients) c.write(`event: app\ndata: ${JSON.stringify(e)}\n\n`); };

  let naive: NaiveClient | null = null;
  const board = opts.board ?? boardFromEnv(naive, runsDir);
  const engine = new ChatEngine({
    chatDir: path.join(runsDir, "chat"),
    runsDir,
    specs: () => specs,
    naive,
    board,
    providerFor: opts.providerFor ?? ((spec) => {
      if (!naive && spec.provider.kind === "naive") throw new Error("NAIVE_API_KEY is not set (add it to .env and restart the adapter)");
      return providerFor(spec, naive);
    }),
    ledgerFile: opts.ledgerFile ?? process.env.STUDIO_LEDGER_FILE ?? path.join(runsDir, "ledger.jsonl"),
    eventStart: opts.eventStart ?? process.env.STUDIO_EVENT_START,
    now: opts.now,
    onChange: (sessionId, messageId) => emit({ type: "session.message", sessionId, messageId }),
  });

  const route = async (p: string): Promise<{ status: number; body: unknown; png?: Buffer }> => {

    const seg = p.split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "api") return { status: 404, body: { error: "not found" } };
    const [, a, b, c] = seg;
    const ok = (body: unknown) => ({ status: 200, body });
    const missing = { status: 404, body: { error: "not found" } };
    const runs = () => allRuns();
    if (a === "art-gallery") return galleryRoute(seg.slice(1), gamesRoot);
    if (a === "registry" && !b) return ok(buildRegistry(specs, new Set(runs().filter((r) => r.run.status === "running").map((r) => r.agent)), engine.list()));
    if (a === "interventions" && !b) return ok(engine.interventions());
    if (a === "weave" && !b) return ok(buildWeave(runs(), specs.map((s) => s.name), approvalsFile, runsDir, await board.list()));
    if (a === "projects" && !b) return ok([PROJECT]);
    if (a === "tasks") {
      const tasks = runs().map((r) => r.task);
      return b ? (tasks.find((t) => t.id === b) ? ok(tasks.find((t) => t.id === b)) : missing) : ok(tasks);
    }
    if (a === "runs") {
      if (!b) return ok(runs().map((r) => r.run));
      const m = runs().find((r) => r.run.id === b);
      if (!m) return missing;
      if (!c) return ok(m.run);
      if (c === "events") return ok(m.events);
      if (c === "snapshots") return ok([]);
      return missing;
    }
    if (a === "reports") return missing;
    if (a === "schedules") return ok([]);
    if (a === "sessions" && b && !c) { engine.events(b); return ok({ sessionId: b, desktop: { url: null, runId: null, screenshotArtifactId: null, replay: false } }); } // no desktop in the studio chat
    if (a === "sessions" && b && c === "messages") return ok(engine.thread(b));
    if (a === "sessions" && b && c === "events") return ok(engine.events(b));
    return missing;
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!originAllowed(origin)) { json(403, { error: "origin not allowed" }); return; }
    if (origin) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
    res.setHeader("access-control-allow-headers", "content-type, last-event-id");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === "POST") {
        if (readOnly) return json(403, { error: "read-only window (mirror)" });
        if (url.pathname === "/api/sessions") {
          const body = CreateSessionRequestSchema.safeParse(await readJson(req));
          if (!body.success) return json(400, { error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          return json(200, { sessionId: engine.create(body.data.agentId, body.data.incognito) });
        }
        if (seg.length === 4 && seg[0] === "api" && seg[1] === "sessions" && seg[3] === "messages") {
          const body = PostMessageRequestSchema.safeParse(await readJson(req));
          if (!body.success) return json(400, { error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          return json(200, engine.post(seg[2], body.data));
        }
        return json(405, { error: "the studio window only accepts chat messages" });
      }
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (seg.length === 4 && seg[0] === "api" && seg[1] === "sessions" && seg[3] === "stream") {
        const after = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? 0) || 0;
        engine.events(seg[2]); // 404 for an unknown session before any SSE headers go out
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.flushHeaders(); // a quiet stream must still "open" for the client (fetch waits for headers)
        const unsubscribe = engine.subscribe(seg[2], after, (f) =>
          res.write(f.kind === "event" ? encodeFrame({ event: "event", id: f.event.seq, data: f.event }) : encodeFrame({ event: "delta", data: f.delta })));
        const ping = setInterval(() => res.write(encodeFrame({ event: "ping" })), 15_000);
        req.on("close", () => { unsubscribe(); clearInterval(ping); });
        return;
      }
      const r = await route(url.pathname);
      if ("png" in r && r.png) {
        res.writeHead(r.status, { "content-type": "image/png", "cache-control": "no-cache" }).end(r.png);
        return;
      }
      json(r.status, r.body);
    } catch (e) {
      if (e instanceof ChatError) return json(e.status, { error: e.message });
      console.error("[window] request failed", url.pathname, e);
      json(500, { error: String((e as Error).message) });
    }
  });

  // Push invalidations when anything under runs/ changes; the UI refetches what it needs.
  let timer: NodeJS.Timeout | undefined;
  const changed = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  if (existsSync(runsDir)) {
    watcher = watch(runsDir, { recursive: true }, (_ev, file) => {
      const id = file?.split(path.sep)[0];
      if (id && id !== "chat") changed.add(id); // chat sessions announce themselves (session.message)
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const runId of changed) { emit({ type: "run.changed", runId }); emit({ type: "task.changed", taskId: `task-${runId}` }); }
        if (changed.size) { emit({ type: "weave.changed" }); emit({ type: "registry.changed" }); }
        changed.clear();
      }, 250);
    });
  }
  const heartbeat = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      watcher?.close(); clearInterval(heartbeat);
      reject(e.code === "EADDRINUSE" ? new Error(`port ${opts.port ?? 8787} is already in use (another adapter running? stop it, or set PORT)`) : e);
    });
    server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  return {
    port,
    runsDir,
    readOnly,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat); clearTimeout(timer); watcher?.close();
      for (const c of clients) c.end();
      server.close(() => resolve());
      server.closeAllConnections(); // open session streams would otherwise keep the server alive
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const s = await startServer({ port: Number(process.env.PORT) || 8787 });
    console.log(`[window] adapter (${s.readOnly ? "read-only, chat disabled" : "read-only except chat"}) on http://127.0.0.1:${s.port}`);
    console.log(`[window] runs dir: ${s.runsDir}${s.readOnly ? "  (mirror: chat writes refused)" : ""}`);
  } catch (e) {
    console.error(`[window] ${(e as Error).message}`);
    process.exit(1);
  }
}
