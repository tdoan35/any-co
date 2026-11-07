// Embed the catalog's real games for the Greenlight gap map. Resumable: re-run to continue.
//   node --env-file=.env --import tsx tools/gapmap/embed.ts [--limit N]
// Writes data/gapmap/games.json (one row per vector, same order) and data/gapmap/vectors.f32
// (N × DIMS float32, unnormalized). Spend is logged to runs/spend.jsonl.
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpendLedger } from "../../runner/spend.ts";
import { withRetry } from "../../runner/providers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GAPMAP_DIR = path.join(ROOT, "data", "gapmap");
export const MODEL = "text-embedding-3-small";
export const DIMS = 256;
export const USD_PER_MTOK = 0.02;
// Small requests: on flaky networks, large (~300 KB) uploads fail mid-transfer far more often.
const BATCH = 100;
const PARALLEL = 6;
// Stay under the org's embeddings tokens-per-minute limit (429s otherwise). Override with GAPMAP_TPM.
const TPM = Number(process.env.GAPMAP_TPM) || 600_000;
// Every real release with tags or a real description: flops count as supply, so they must be on the map.

export interface GameRow {
  appid: number;
  name: string;
  date: string | null; // ISO release date
  year: number | null;
  reviews: number;
  traction: boolean; // >= 50 reviews
  price: number;
  tags: string[];
}

export function cleanAbout(s: string): string {
  return (s ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

// The name is left out on purpose: shared words in titles ("Elder", "Omen") made unrelated
// games neighbors. Tags, genres, and the description carry what the game is.
export function embedText(tags: string[], genres: string[], about: string): string {
  return `Tags: ${tags.slice(0, 15).join(", ")}. Genres: ${genres.join(", ")}. ${cleanAbout(about).slice(0, 700)}`;
}

export async function embed(inputs: string[], apiKey: string): Promise<{ vectors: number[][]; tokens: number }> {
  const res = await withRetry(async () => {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, input: inputs, dimensions: DIMS }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw Object.assign(new Error(`openai embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
    return r.json() as Promise<any>;
  }, "openai-embeddings", 8, 1500);
  return { vectors: res.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding), tokens: res.usage.total_tokens };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set (see .env)");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  mkdirSync(GAPMAP_DIR, { recursive: true });

  const db = new DatabaseSync(path.join(ROOT, "data", "catalog.sqlite"), { readOnly: true });
  const rows = db
    .prepare(
      `SELECT appid, name, release_date, release_year, reviews_total, price, about FROM games
       WHERE is_real = 1 AND (appid IN (SELECT appid FROM game_tags) OR length(about) >= 200) ORDER BY appid`,
    )
    .all() as any[];
  const tagsOf = db.prepare("SELECT tag FROM game_tags WHERE appid = ? ORDER BY rowid");
  const genresOf = db.prepare("SELECT genre FROM game_genres WHERE appid = ? ORDER BY rowid");
  const all = rows.slice(0, limit);

  const gamesFile = path.join(GAPMAP_DIR, "games.jsonl");
  const vecFile = path.join(GAPMAP_DIR, "vectors.f32");
  // Resume: vectors.f32 holds complete rows only; games.jsonl is trimmed to match.
  const doneVec = existsSync(vecFile) ? Math.floor(statSync(vecFile).size / (DIMS * 4)) : 0;
  const doneRows = existsSync(gamesFile) ? readFileSync(gamesFile, "utf8").split("\n").filter(Boolean) : [];
  const done = Math.min(doneVec, doneRows.length);
  if (doneRows.length !== done || doneVec !== done) {
    writeFileSync(gamesFile, doneRows.slice(0, done).map((l) => l + "\n").join(""));
    const buf = done ? readFileSync(vecFile).subarray(0, done * DIMS * 4) : Buffer.alloc(0);
    writeFileSync(vecFile, buf);
  }
  console.log(`games: ${all.length}, already embedded: ${done}`);

  const ledger = new SpendLedger(path.join(ROOT, "runs", "spend.jsonl"));
  const runId = `gapmap-embed-${new Date().toISOString().slice(0, 19)}`;
  let tokens = 0;
  const t0 = Date.now();
  const window: Array<{ t: number; tokens: number }> = []; // tokens sent in the last minute
  const pace = async (next: number) => {
    for (;;) {
      const now = Date.now();
      while (window.length && now - window[0].t > 60_000) window.shift();
      const used = window.reduce((s, w) => s + w.tokens, 0);
      if (used + next <= TPM || !window.length) return;
      await new Promise((r) => setTimeout(r, Math.max(500, 60_000 - (now - window[0].t))));
    }
  };
  for (let start = done; start < all.length; start += BATCH * PARALLEL) {
    const chunks: { rows: any[]; meta: GameRow[]; text: string[] }[] = [];
    for (let s = start; s < Math.min(all.length, start + BATCH * PARALLEL); s += BATCH) {
      const part = all.slice(s, Math.min(all.length, s + BATCH));
      const meta: GameRow[] = [];
      const text: string[] = [];
      for (const r of part) {
        const tags = (tagsOf.all(r.appid) as any[]).map((t) => t.tag);
        const genres = (genresOf.all(r.appid) as any[]).map((g) => g.genre);
        meta.push({ appid: r.appid, name: r.name, date: r.release_date, year: r.release_year, reviews: r.reviews_total, traction: r.reviews_total >= 50, price: r.price, tags: tags.slice(0, 12) });
        text.push(embedText(tags, genres, r.about));
      }
      chunks.push({ rows: part, meta, text });
    }
    const estimate = chunks.reduce((s, c) => s + c.text.reduce((a, x) => a + Math.ceil(x.length / 4), 0), 0);
    await pace(estimate);
    window.push({ t: Date.now(), tokens: estimate });
    const results = await Promise.all(chunks.map((c) => embed(c.text, apiKey)));
    // Append in order so the two files stay aligned; vectors first, then rows (resume trims).
    for (let i = 0; i < chunks.length; i++) {
      const v = new Float32Array(results[i].vectors.flat());
      if (v.length !== chunks[i].meta.length * DIMS) throw new Error("embedding count mismatch");
      appendFileSync(vecFile, Buffer.from(v.buffer));
      appendFileSync(gamesFile, chunks[i].meta.map((m) => JSON.stringify(m) + "\n").join(""));
      tokens += results[i].tokens;
      ledger.append({ ts: new Date().toISOString(), run_id: runId, agent: "gapmap-build", kind: "tool", what: `openai:${MODEL}`, micro_usd: Math.ceil(results[i].tokens * USD_PER_MTOK) });
    }
    const n = Math.min(all.length, start + BATCH * PARALLEL);
    const rate = (n - done) / ((Date.now() - t0) / 1000);
    console.log(`${n}/${all.length}  tokens ${tokens}  $${((tokens * USD_PER_MTOK) / 1e6).toFixed(4)}  ~${Math.round((all.length - n) / rate)}s left`);
  }
  writeFileSync(path.join(GAPMAP_DIR, "embed-meta.json"), JSON.stringify({ model: MODEL, dims: DIMS, filter: "is_real and (tagged or description >= 200 chars)", count: all.length, text: "tags + genres + description (no name)", built_at: new Date().toISOString() }, null, 2));
  console.log(`done. this session: ${tokens} tokens, $${((tokens * USD_PER_MTOK) / 1e6).toFixed(4)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
