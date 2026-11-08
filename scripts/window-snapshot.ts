// Static, read-only snapshot of the studio window's data, for the getany.org demo (window VITE_API_MODE=snapshot).
//   node --env-file-if-exists=.env --import tsx scripts/window-snapshot.ts [--out DIR] [--run <id>]... [--no-media] [--label TEXT]
// Starts the adapter in-process (read-only, ephemeral port), GETs what the window reads, and writes:
//   <out>/api/<path>.json            every JSON GET (query string dropped)
//   <out>/api/<adapter path>         binaries (art-gallery PNGs, showcase files) at their exact adapter path
//   <out>/api/gapmap.html            the gap map
//   <out>/meta.json                  { asOf, label?, runs }
// Run details/events only for a curated subset (DEFAULT_RUNS + the latest done run of each SAMPLE_AGENTS agent + --run).
// Scrubbed: the repo/home paths, emails, the owner's name. Refuses to finish if any .env value or token pattern survives.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "../window/server/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    out: { type: "string", default: path.join(ROOT, "runs", "handoff", "window-snapshot", "snapshot") },
    run: { type: "string", multiple: true, default: [] },
    "no-media": { type: "boolean", default: false },
    label: { type: "string" },
  },
});
const OUT = path.resolve(values.out!);

// Representative runs: both greenlights end to end, the title-screen fix, the trailers.
const DEFAULT_RUNS = [
  "20261107-132237-market-analyst", "20261107-133156-game-director", "20261107-133512-greenlight-chair",
  "20261107-204914-market-analyst", "20261107-210956-game-director", "20261107-211312-greenlight-chair",
  "20261108-062026-tech-lead", "20261108-073202-tech-lead",
  "20261108-093049-short-form-video-producer", "20261108-094057-short-form-video-producer",
];
const SAMPLE_AGENTS = ["studio-head", "art-director", "sprite-artist", "qa-lead", "playtester", "build-release", "marketing-lead", "studio-historian", "finance-compliance"];

// ---- scrubbing ------------------------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SCRUB: [RegExp, string][] = [
  [new RegExp(esc(ROOT) + "/?", "g"), ""],
  [new RegExp(esc(os.homedir()), "g"), "~"],
  [/\/(Users|home)\/[A-Za-z0-9._-]+/g, "~"],
  [/\/private\/tmp\/[^\s"'`)]*/g, "<tmp>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/Ty Thanh Doan/gi, "the owner"],
];
// The OS account name (e.g. in `ls -l` lines agents printed): replaced with "user", and a hard failure if any survives.
const USERNAMES = [...new Set([os.userInfo().username, path.basename(os.homedir())])].filter((u) => u.length >= 3);
for (const u of USERNAMES) SCRUB.push([new RegExp(`\\b${esc(u)}\\b`, "gi"), "user"]);
const scrub = (s: string) => SCRUB.reduce((a, [re, to]) => a.replace(re, to), s);
const scrubDeep = (v: unknown): unknown =>
  typeof v === "string" ? scrub(v) : Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubDeep(x)])) : v;

// Secrets: every .env value of 12+ chars, plus common token shapes. Never printed, only counted.
const envSecrets = existsSync(path.join(ROOT, ".env"))
  ? readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").map((l) => l.replace(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "").replace(/^["']|["']$/g, "").trim()).filter((v) => v.length >= 12)
  : [];
const TOKEN_RE = /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/;
const leaks: string[] = [];
const check = (file: string, text: string) => {
  const lower = text.toLowerCase();
  if (envSecrets.some((s) => text.includes(s)) || TOKEN_RE.test(text) || USERNAMES.some((u) => lower.includes(u.toLowerCase()))) leaks.push(path.relative(OUT, file));
};

// ---- export ---------------------------------------------------------------------------------------------------
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = await startServer({ port: 0, host: "127.0.0.1", readOnly: true });
const base = `http://127.0.0.1:${server.port}`;
let bytes = 0, files = 0;
const write = (rel: string, data: Buffer | string) => {
  const file = path.join(OUT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  bytes += Buffer.byteLength(data); files++;
  return file;
};
const getJson = async (p: string, required = true): Promise<unknown> => {
  const r = await fetch(base + "/api" + p);
  if (r.status === 404 && !required) return undefined;
  if (!r.ok) throw new Error(`GET /api${p}: ${r.status}`);
  const body = scrubDeep(await r.json());
  const text = JSON.stringify(body);
  check(write(`api${p.split("?")[0]}.json`, text), text);
  return body;
};
const media = new Set<string>();
const collectMedia = (v: unknown) => {
  if (typeof v === "string" && /^\/api\/(art-gallery\/[^/]+\/(png|file)|showcase\/[^/]+\/file)\//.test(v)) media.add(v);
  else if (Array.isArray(v)) v.forEach(collectMedia);
  else if (v && typeof v === "object") Object.values(v).forEach(collectMedia);
};

try {
  for (const p of ["/registry", "/weave", "/board-summary", "/board-cards", "/interventions", "/projects", "/schedules"]) await getJson(p);
  const runs = (await getJson("/runs")) as { id: string; agentId?: string; agent?: string; status?: string; startedAt?: string }[];
  const tasks = (await getJson("/tasks")) as { id: string; runId?: string }[];
  collectMedia(await getJson("/art-gallery"));
  collectMedia(await getJson("/showcase"));

  const gap = await fetch(base + "/api/gapmap");
  if (gap.ok) { const t = scrub(await gap.text()); check(write("api/gapmap.html", t), t); }

  // curated runs
  const ids = new Set(values.run!.length ? values.run! : DEFAULT_RUNS);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const agentOf = (id: string) => id.replace(/^\d{8}-\d{6}-/, "");
  if (!values.run!.length) for (const a of SAMPLE_AGENTS) {
    const latest = runs.filter((r) => agentOf(r.id) === a && r.status === "accepted").sort((x, y) => y.id.localeCompare(x.id))[0];
    if (latest) ids.add(latest.id);
  }
  const exported: string[] = [];
  for (const id of ids) {
    if (!byId.has(id)) { console.warn(`[snapshot] skip ${id}: not in /api/runs`); continue; }
    const enc = encodeURIComponent(id);
    await getJson(`/runs/${enc}`);
    await getJson(`/runs/${enc}/events`);
    await getJson(`/runs/${enc}/snapshots`, false);
    const task = tasks.find((t) => t.runId === id || t.id === `task-${id}`);
    if (task) await getJson(`/tasks/${encodeURIComponent(task.id)}`, false);
    exported.push(id);
  }

  // binaries at their exact adapter path
  if (!values["no-media"]) for (const u of media) {
    const r = await fetch(base + u);
    if (!r.ok) { console.warn(`[snapshot] skip ${u}: ${r.status}`); continue; }
    write(decodeURI(u).replace(/^\//, ""), Buffer.from(await r.arrayBuffer()));
  }

  write("meta.json", JSON.stringify({ asOf: new Date().toISOString(), ...(values.label ? { label: values.label } : {}), runs: exported }, null, 2));
  if (leaks.length) {
    rmSync(OUT, { recursive: true, force: true });
    throw new Error(`secret check failed in ${leaks.length} file(s): ${leaks.join(", ")} — snapshot deleted`);
  }
  console.log(`[snapshot] ${files} files, ${(bytes / 1e6).toFixed(1)} MB → ${OUT}`);
  console.log(`[snapshot] ${exported.length} runs with details, ${media.size} media files${values["no-media"] ? " (skipped)" : ""}; secret check clean`);
} finally {
  await server.close();
}
