// T46: mechanical art-only merges into a game repo's main. Temp git repos only (never games/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artMerge } from "./merge.ts";
import { runMergeCommand } from "./art.ts";
import { agentClone, git, mainSha, makeGameRepo, manifest, pushBranch, readMain } from "./testdata/game-repo.ts";
import { read as readLedger } from "../ledger/ledger.ts";

function state() {
  const runsDir = mkdtempSync(path.join(tmpdir(), "artmerge-runs-"));
  return { runsDir, ledgerFile: path.join(runsDir, "ledger.jsonl") };
}

test("T46: an art-only branch fast-forwards main (live checkout updated), with one art.merge ledger decision", async () => {
  const game = makeGameRepo();
  const before = mainSha(game);
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime"]), "assets/sprites/slime.png": null, "assets/sprites/slime.png.import": "[remap]\n", "art/gallery/slime/1-comfy-accepted.png": null });
  const s = state();
  const r = await artMerge(game, "agent/sprite-artist", s);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.mode, "fast-forward");
  assert.equal(r.base, before);
  assert.equal(r.assets, 1, "slime.png; manifest and sidecar not counted as assets");
  assert.equal(mainSha(game), git(clone, ["rev-parse", "HEAD"]), "main is the branch head");
  assert.ok(existsSync(path.join(game, "assets", "sprites", "slime.png")), "the live checkout was updated (updateInstead)");
  const notes = readLedger(s.ledgerFile).filter((e) => e.kind === "decision" && e.topic === "art.merge");
  assert.equal(notes.length, 1);
  assert.match(String((notes[0] as { decision?: string }).decision), /merged agent\/sprite-artist into caravan main mechanically \(fast-forward\).*1 asset file\(s\), gate ok/);
});

test("T46: a diverged art-only branch lands as a clean --no-ff merge commit", async () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "env-ui-artist");
  pushBranch(clone, "env-ui-artist", { "assets/manifest.json": manifest(["hero", "panel"]), "assets/sprites/panel.png": null });
  writeFileSync(path.join(game, "src", "main.gd"), "extends Node2D\n"); // main moves on (a tech-lead merge)
  git(game, ["commit", "-qam", "engine change"]);
  const r = await artMerge(game, "agent/env-ui-artist", state());
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.mode, "merge");
  assert.match(git(game, ["log", "-1", "--format=%s", "main"]), /^Art merge agent\/env-ui-artist \(harness, mechanical/);
  assert.equal(readMain(game, "src/main.gd"), "extends Node2D\n", "main's own change survives");
});

test("T46: a branch touching anything outside assets/ and art/gallery/ is refused; main untouched", async () => {
  const game = makeGameRepo();
  const before = mainSha(game);
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/sprites/hero.png": null, "src/main.gd": "extends Node3D\n", "project.godot": "x" });
  const r = await artMerge(game, "agent/sprite-artist", state());
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^not art-only: project\.godot, src\/main\.gd$/);
  assert.equal(mainSha(game), before);
});

test("T46b: helper scripts and scratch sheets under art/ are inert data and merge; engine code under assets/ or art/ is refused", async () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", {
    "assets/sprites/hero.png": null,
    "art/tools/ascii_view.py": "print('x')\n",
    "art/tools/paldump.py": "print('y')\n",
    "art/capsule-v2-candidates-sheet.png": null,
  });
  const r = await artMerge(game, "agent/sprite-artist", state());
  assert.equal(r.ok, true, String(r.reason));
  assert.equal(readMain(game, "art/tools/paldump.py"), "print('y')\n");

  const game2 = makeGameRepo();
  const before = mainSha(game2);
  const clone2 = agentClone(game2, "sprite-artist");
  pushBranch(clone2, "sprite-artist", { "assets/sprites/hero.png": null, "art/tools/loader.gd": "extends Node\n", "assets/fx/glow.tscn": "[gd_scene]\n" });
  const r2 = await artMerge(game2, "agent/sprite-artist", state());
  assert.equal(r2.ok, false);
  assert.match(r2.reason!, /^not art-only: art\/tools\/loader\.gd, assets\/fx\/glow\.tscn$/);
  assert.equal(mainSha(game2), before);
});

test("T46: a conflict is refused (needs a tech-lead card) and main is untouched", async () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime"]), "assets/sprites/slime.png": null });
  writeFileSync(path.join(game, "assets", "manifest.json"), manifest(["hero", "bat"])); // main edits the same lines
  writeFileSync(path.join(game, "assets", "sprites", "bat.png"), "x");
  git(game, ["add", "-A"]);
  git(game, ["commit", "-qm", "other art on main"]);
  const before = mainSha(game);
  const r = await artMerge(game, "agent/sprite-artist", state());
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^conflict: assets\/manifest\.json → needs a tech-lead card$/);
  assert.equal(mainSha(game), before);
});

test("T46: the gate runs on the merged tree; a failure is refused with its summary and main is untouched", async () => {
  const game = makeGameRepo();
  const before = mainSha(game);
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/sprites/stray.png": null }); // on disk, not in the manifest
  const r = await artMerge(game, "agent/sprite-artist", state());
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^gate failed on the merged tree \(unlisted: assets\/sprites\/stray\.png\)$/);
  assert.equal(r.gate?.ok, false);
  assert.equal(mainSha(game), before);
});

test("T46: dry run merges and gates without pushing; bad branches and a busy repo are refused", async () => {
  const game = makeGameRepo();
  const before = mainSha(game);
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime"]), "assets/sprites/slime.png": null });
  const s = state();
  const dry = await artMerge(game, "agent/sprite-artist", { ...s, dryRun: true });
  assert.equal(dry.ok, true, dry.reason ?? "");
  assert.equal(dry.dry_run, true);
  assert.equal(mainSha(game), before, "nothing pushed");
  assert.equal(readLedger(s.ledgerFile).length, 0, "nothing ledgered");
  assert.match((await artMerge(game, "main", s)).reason!, /only agent\/<name> branches/);
  assert.match((await artMerge(game, "agent/nobody", s)).reason!, /has no branch agent\/nobody/);
  // another merge holds this repo's lock (a live pid): refused after the wait, nothing moved
  mkdirSync(path.join(s.runsDir, "locks", "art-merge-caravan.lock"), { recursive: true });
  writeFileSync(path.join(s.runsDir, "locks", "art-merge-caravan.lock", "pid"), String(process.pid));
  assert.match((await artMerge(game, "agent/sprite-artist", { ...s, lockWaitMs: 50 })).reason!, /another art merge on this game repo is still running/);
  // a stale lock (its process is gone) is taken over
  writeFileSync(path.join(s.runsDir, "locks", "art-merge-caravan.lock", "pid"), "999999");
  assert.equal((await artMerge(game, "agent/sprite-artist", { ...s, lockWaitMs: 50 })).ok, true);
});

test("T46: the single-merger hook is not weakened: an agent's own push to main is still refused", () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "art/gallery/hero/1-comfy-rejected.png": null });
  assert.throws(() => git(clone, ["push", "-q", "origin", "HEAD:main"], { ...process.env, ANYCO_AGENT: "sprite-artist" }), /only the tech-lead agent may update main/);
});

test("T46: the operator CLI merges, and refuses a process an agent started", async () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "sprite-artist");
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime"]), "assets/sprites/slime.png": null });
  const prev = { agent: process.env.ANYCO_AGENT, ledger: process.env.STUDIO_LEDGER_FILE };
  process.env.STUDIO_LEDGER_FILE = state().ledgerFile;
  try {
    process.env.ANYCO_AGENT = "sprite-artist";
    const refused = await runMergeCommand([game, "agent/sprite-artist"]);
    assert.equal(refused.exitCode, 2);
    assert.match(String((refused.json as { error?: string }).error), /operator command .* started by agent "sprite-artist"/);
    delete process.env.ANYCO_AGENT;
    const dry = await runMergeCommand([game, "agent/sprite-artist", "--dry-run"]);
    assert.equal(dry.exitCode, 0, JSON.stringify(dry.json));
    const ok = await runMergeCommand([game, "agent/sprite-artist"]);
    assert.equal(ok.exitCode, 0, JSON.stringify(ok.json));
    assert.equal(mainSha(game), git(clone, ["rev-parse", "HEAD"]));
  } finally {
    for (const [k, v] of [["ANYCO_AGENT", prev.agent], ["STUDIO_LEDGER_FILE", prev.ledger]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("T46 security: the game repo comes from the clone's origin only when it is a real repo directly under the games root", async () => {
  const { gameRepoOfClone } = await import("./merge.ts");
  const { makeGameRepo: mk, agentClone: ac } = await import("./testdata/game-repo.ts");
  const { realpathSync: rp, writeFileSync: wf, mkdtempSync: mt, mkdirSync: md, symlinkSync } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const p = await import("node:path");
  const game = mk();
  const clone = ac(game, "sprite-artist");
  assert.equal(gameRepoOfClone(clone, p.dirname(game)), rp(game));
  // another root: refused
  assert.equal(gameRepoOfClone(clone, mt(p.join(td(), "other-root-"))), null);
  // origin re-pointed at a repo outside the games root (e.g. the harness): refused
  const outside = mk();
  const cfg = p.join(clone, ".git", "config");
  const orig = (await import("node:fs")).readFileSync(cfg, "utf8");
  wf(cfg, orig.replace(/url = .*/, `url = ${outside}`));
  assert.equal(gameRepoOfClone(clone, p.dirname(game)), null);
  // a symlink under the games root pointing elsewhere: refused (realpath leaves the root)
  const link = p.join(p.dirname(game), "linked");
  symlinkSync(p.dirname(outside) + "/caravan", link);
  wf(cfg, orig.replace(/url = .*/, `url = ${link}`));
  assert.equal(gameRepoOfClone(clone, p.dirname(game)), null);
  // relative url / no origin: refused
  wf(cfg, orig.replace(/url = .*/, "url = ../x"));
  assert.equal(gameRepoOfClone(clone, p.dirname(game)), null);
});

test("T46c: criss-cross history (branch merged main, main merged the branch, main moved on) is judged on what the merge changes on main", async () => {
  const game = makeGameRepo();
  const clone = agentClone(game, "sprite-artist");
  // B1: the branch adds a sprite
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime"]), "assets/sprites/slime.png": null }, "B1 slime");
  const b1 = git(clone, ["rev-parse", "HEAD"]);
  // M1: main gets a non-art commit
  writeFileSync(path.join(game, "src", "main.gd"), "extends Node2D\n");
  git(game, ["commit", "-qam", "M1 engine"]);
  // B2: the branch merges main at clone/refresh time
  git(clone, ["fetch", "-q", "origin"]);
  git(clone, ["merge", "-q", "--no-edit", "origin/main"]);
  git(clone, ["push", "-q", "origin", "agent/sprite-artist"], { ...process.env, ANYCO_AGENT: "sprite-artist" });
  // M2: main merges the OLD branch tip B1 (criss-cross: merge bases are now M1 and B1)
  git(game, ["merge", "-q", "--no-ff", "--no-edit", b1]);
  // M3: main moves on with more non-art work
  mkdirSync(path.join(game, "audio"), { recursive: true });
  writeFileSync(path.join(game, "audio", "gen_music.py"), "print('m')\n");
  git(game, ["add", "-A"]);
  git(game, ["commit", "-qm", "M3 audio tool"]);
  // B3: the branch only adds another sprite
  pushBranch(clone, "sprite-artist", { "assets/manifest.json": manifest(["hero", "slime", "bat"]), "assets/sprites/bat.png": null }, "B3 bat");
  assert.ok(git(game, ["merge-base", "--all", "main", "agent/sprite-artist"]).split("\n").length >= 1);

  const r = await artMerge(game, "agent/sprite-artist", state());
  assert.equal(r.ok, true, String(r.reason));
  assert.deepEqual([...r.changed].sort(), ["assets/manifest.json", "assets/sprites/bat.png"]);
  assert.equal(readMain(game, "audio/gen_music.py"), "print('m')\n", "main's own work survives");
});
