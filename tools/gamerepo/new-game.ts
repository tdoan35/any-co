// Bootstrap the studio's game repo after the Greenlight pick: games/<slug> as its own git repo with one
// empty commit, so the game_repo capability (runner/tools/impl.ts) can clone it. Mechanical only: the name
// comes from the Greenlight Chair's output, and no game content is written.
//   node --import tsx tools/gamerepo/new-game.ts runs/<greenlight-chair-run> [--games-dir games]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Lowercase ASCII slug: letters and digits, words joined by "-", at most 60 chars. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!s) throw new Error(`title "${title}" has no usable characters for a repo name`);
  return s;
}

/** The picked working title from a Greenlight Chair run's output.json. */
export function pickedTitle(chairRunDir: string): string {
  const out = JSON.parse(readFileSync(path.join(chairRunDir, "output.json"), "utf8"));
  const t = out?.pick?.working_title;
  if (typeof t !== "string" || !t.trim()) throw new Error(`${chairRunDir}/output.json has no pick.working_title`);
  return t;
}

/** Create games/<slug> with an empty initial commit. Refuses if the directory already exists. */
export function createGameRepo(title: string, gamesDir = path.join(ROOT, "games")): { slug: string; dir: string; sha: string } {
  const slug = slugify(title);
  const dir = path.join(gamesDir, slug);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git(
    "-c", "user.name=any-co harness", "-c", "user.email=harness@any-co.invalid",
    "commit", "-q", "--allow-empty", "-m", `Initialize ${slug} (harness bootstrap after the Greenlight pick)`,
  );
  return { slug, dir, sha: git("rev-parse", "HEAD") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const run = args.find((a) => !a.startsWith("--"));
  const gi = args.indexOf("--games-dir");
  if (!run) {
    console.error("usage: new-game.ts runs/<greenlight-chair-run> [--games-dir games]");
    process.exit(2);
  }
  const r = createGameRepo(pickedTitle(run), gi >= 0 ? path.resolve(args[gi + 1]) : undefined);
  console.log(JSON.stringify(r, null, 2));
}
