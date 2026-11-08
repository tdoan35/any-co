// Test helper (T46): a throwaway game repo shaped like games/<slug> (non-bare, updateInstead, the single-merger
// pre-receive hook) with a valid asset manifest, plus agent clones that commit and push agent/* branches. Never games/.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "../png.ts";
import { installGuards } from "../../gamerepo/new-game.ts";

export const PALETTE = ["#1a1c2c", "#f4f4f4"];
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();

const entry = (id: string) => ({ id, type: "sprite", path: `assets/sprites/${id}.png`, size: { w: 16, h: 16 }, palette: PALETTE, anchor: null });
export function manifest(ids: string[]): string {
  return JSON.stringify({ schema_version: 1, style_bible: "docs/style-bible.md", grid: { w: 16, h: 16 }, palette: PALETTE, assets: ids.map(entry) }, null, 2) + "\n";
}

/** games/<slug>-shaped repo: main has src/main.gd, assets/manifest.json and one listed sprite. */
export function makeGameRepo(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "artmerge-")), "caravan");
  mkdirSync(path.join(dir, "assets", "sprites"), { recursive: true });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "src", "main.gd"), "extends Node\n");
  writeFileSync(path.join(dir, "assets", "manifest.json"), manifest(["hero"]));
  writeFileSync(path.join(dir, "assets", "sprites", "hero.png"), encodePng(makeImage(16, 16)));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  installGuards(dir);
  return dir;
}

/** Clone the game repo into `into` (default a temp dir), on agent/<name>. */
export function agentClone(gameDir: string, agent: string, into?: string): string {
  const clone = into ?? path.join(mkdtempSync(path.join(tmpdir(), "artmerge-clone-")), "game");
  git(path.dirname(clone), ["clone", "-q", gameDir, clone]);
  git(clone, ["checkout", "-q", "-b", `agent/${agent}`]);
  return clone;
}

/** Commit `files` (path → content, or a 16x16 PNG when content is null) and push the agent branch as that agent. */
export function pushBranch(clone: string, agent: string, files: Record<string, string | null>, message = "art"): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    writeFileSync(path.join(clone, rel), content ?? encodePng(makeImage(16, 16)));
  }
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", message]);
  git(clone, ["push", "-q", "origin", `agent/${agent}`], { ...process.env, ANYCO_AGENT: agent });
}

export const mainSha = (gameDir: string) => git(gameDir, ["rev-parse", "main"]);
export const readMain = (gameDir: string, rel: string) => readFileSync(path.join(gameDir, rel), "utf8");
