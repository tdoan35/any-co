import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { designTask } from "./handoff.ts";
import { checkDesignDoc, docAtCommit, parseScope, sectionText, type ChairPick, type DesignManifest } from "./design.ts";

// Neutral synthetic data only: no real game, genre, mechanic, or title from the studio's runs.
const pick: ChairPick = {
  working_title: "Alpha Tray",
  why: "Best buildability and the strongest want coverage of the survivors.",
  adopted_must: [
    { item: "Assembly table UI: place pieces on the board grid with highlight-on-hover", critic_hours: 3.5 },
    { item: "Scoring resolver: per-piece trigger table read from data", critic_hours: 2.5 },
  ],
  deferred: ["Bonus layout mode (2h): deferred because the two adopted items are the skeleton and total exactly 6h"],
  art_and_qa: ["Art: 6-frame animation set reused across all pieces.", "QA: every trigger fires in every grid position."],
  conditions: ["No timers on the first screen (Critic's major fix)."],
  rejected: [{ working_title: "Beta Board", why_not: "Weakest feasibility and a 12h must list needing deep cuts." }],
  risks_to_watch: ["If one layout dominates, retune before adding content."],
};

const pitch = {
  working_title: "Alpha Tray",
  gap_label: "Gap One",
  wants_addressed: [{ want: "I want to plan without a clock", how: "Untimed placement" }],
  animation_budget: { animated_characters: 2, frames_per_character: 3, notes: "" },
  scope: { must: pick.adopted_must!.map((m) => ({ item: m.item, hours: m.critic_hours })), should: ["Bonus layout mode"], could: [] },
};

/** A runs/ tree: player-voice brief, director run, loop, and the Chair run that picked. */
function makeRunsRoot(): { root: string; chairDir: string } {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "anyco-design-")), "runs");
  mkdirSync(path.join(root, "pv"), { recursive: true });
  mkdirSync(path.join(root, "gd"), { recursive: true });
  mkdirSync(path.join(root, "greenlight-t1"), { recursive: true });
  mkdirSync(path.join(root, "chair"), { recursive: true });
  writeFileSync(
    path.join(root, "pv", "handoff-pitches.md"),
    ["# Player findings", "", "## Gap One", "- I want to plan without a clock (57% of 120 negative reviews of appid 1 mention \"timer\") — pressure kills the fun.", ""].join("\n"),
  );
  writeFileSync(path.join(root, "gd", "output.json"), JSON.stringify({ pitches: [pitch, { ...pitch, working_title: "Beta Board" }] }));
  writeFileSync(path.join(root, "gd", "run.json"), JSON.stringify({ run_id: "gd", status: "ok" }));
  writeFileSync(
    path.join(root, "greenlight-t1", "loop.json"),
    JSON.stringify({ brief: "runs/pv/handoff-pitches.md", rounds: [{ round: 0, director_run: "gd", critic_run: "gc", verdicts: [] }] }),
  );
  writeFileSync(
    path.join(root, "chair", "run.json"),
    JSON.stringify({ task: "Greenlight pick: choose the game.\nRefs: director run gd, critic run gc, loop greenlight-t1." }),
  );
  writeFileSync(path.join(root, "chair", "output.json"), JSON.stringify({ pick }));
  return { root, chairDir: "chair" };
}

test("designTask builds the design brief from the Chair run, the loop, and the brief", () => {
  const { root, chairDir } = makeRunsRoot();
  const task = designTask(chairDir, root);
  const blocks = [...task.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { ...pick, risks_to_watch: pick.risks_to_watch }); // first block: the Chair's pick, verbatim
  assert.deepEqual(blocks[1], pitch); // second block: the chosen pitch from the loop's final round
  assert.match(task, /Refs: chair run chair, loop greenlight-t1, director run gd, brief runs\/pv\/handoff-pitches\.md\./);
  assert.match(task, /- I want to plan without a clock \(57% of 120 negative reviews/); // sized finding line from the brief
  assert.match(task, /exactly the Chair's adopted_must items and hours \(6h total/);
  // a pick that is not in the final round is a hard error, not a guess
  writeFileSync(path.join(root, "chair", "output.json"), JSON.stringify({ pick: { ...pick, working_title: "No Such Pitch" } }));
  assert.throws(() => designTask(chairDir, root), /No Such Pitch/);
  rmSync(path.dirname(root), { recursive: true, force: true });
});

const goodDoc = [
  "## Pitch",
  "One paragraph about the chosen game.",
  "## Core loop",
  "1. Read the table. 2. Place pieces. 3. Resolve.",
  "## Scope",
  "### Must",
  "| Assembly table UI: place pieces on the board grid with highlight-on-hover | 3.5 |",
  "| Scoring resolver: per-piece trigger table read from data | 2.5 |",
  "### Should",
  "| Bonus layout mode | 2 |",
  "### Could",
  "| Daily layouts | - |",
  "## Conditions",
  "- No timers on the first screen (Critic's major fix).",
  "## Systems",
  "### Assembly table UI: place pieces on the board grid with highlight-on-hover",
  "Drag, drop, highlight. Reads piece definitions from content/pieces.json.",
  "### Scoring resolver: per-piece trigger table read from data",
  "Tick over the packed table reading content/triggers.json.",
  "## Content as data",
  "### content/pieces.json",
  "Entity type piece: id (string), weight (int 1–4), count target 20.",
  "### content/triggers.json",
  "Entity type trigger: id (string), effect (string), chance (float 0–1), count target 12.",
  "## Balance targets",
  "Run length 8–12 minutes (target 10). Win rate band 35–55%.",
  "## Art needs",
  "2 animated characters × 3 frames = 6 frames, plus board tiles and UI chrome.",
  "## Out of scope",
  "Beta Board — rejected in Greenlight. Timed modes.",
  "",
].join("\n");

const goodOut: DesignManifest = {
  branch: "agent/game-director-design",
  commit: "0123456789abcdef",
  doc_path: "docs/design.md",
  should_count: 1,
  could_count: 1,
  data_files: [{ path: "content/pieces.json", what: "piece definitions" }, { path: "content/triggers.json", what: "trigger table" }],
};

test("a compliant design doc passes every check", () => {
  assert.deepEqual(checkDesignDoc(goodDoc, pick, goodOut), []);
  assert.deepEqual(parseScope(sectionText(goodDoc, "Scope")).must, pick.adopted_must!.map((m) => ({ item: m.item, hours: m.critic_hours })));
});

test("each hard rule fails loudly when broken", () => {
  const broken: Array<[string, RegExp, DesignManifest?]> = [
    [goodDoc.replace("## Balance targets", "## Targets"), /missing section "## Balance targets"/],
    [goodDoc.replace("| Scoring resolver: per-piece trigger table read from data | 2.5 |", "| Scoring resolver: per-piece trigger table read from data | 5 |"), /5h in the doc vs the Chair's 2\.5h/],
    [goodDoc.replace("### Should\n| Bonus layout mode | 2 |", "### Should\n| Something else entirely | 2 |"), /deferred item "Bonus layout mode/],
    [goodDoc.replace("- No timers on the first screen (Critic's major fix).", "- No clocks at the start."), /condition not copied verbatim/],
    [goodDoc.replace("| Scoring resolver: per-piece trigger table read from data | 2.5 |\n", "| Scoring resolver: per-piece trigger table read from data | 2.5 |\n| Sneaky extra system | 4 |\n"), /Must table adds "Sneaky extra system/],
    [goodDoc.replace("### content/pieces.json", "### content/other.json"), /data file "content\/pieces\.json".*not under "## Content as data"/],
    [goodDoc.replace("One paragraph about the chosen game.", "One paragraph about the chosen game, unlike Beta Board."), /rejected pitch "Beta Board" appears/],
    [goodDoc, /should_count 2 vs 1/, { ...goodOut, should_count: 2 }],
  ];
  for (const [doc, re, out = goodOut] of broken) assert.match(checkDesignDoc(doc, pick, out).join("\n"), re);
  // naming a rejected pitch only under Out of scope is correct, not a violation
  assert.equal(checkDesignDoc(goodDoc, pick, goodOut).length, 0);
});

test("docAtCommit reads the doc from a real clone at the reported commit", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "anyco-clone-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch", "main");
  mkdirSync(path.join(clone, "docs"));
  writeFileSync(path.join(clone, "docs", "design.md"), goodDoc);
  execFileSync("git", ["-C", clone, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "design doc");
  const sha = git("rev-parse", "HEAD").trim();

  assert.equal(docAtCommit(clone, sha).doc, goodDoc);
  assert.equal(docAtCommit(clone, sha.slice(0, 10)).doc, goodDoc); // short sha works too
  assert.match(docAtCommit(clone, "deadbeef").error ?? "", /deadbeef/);
  assert.match(docAtCommit(clone, sha, "docs/missing.md").error ?? "", /missing/); // doc not at that commit
  rmSync(clone, { recursive: true, force: true });
});
