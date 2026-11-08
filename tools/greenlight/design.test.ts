import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { designTask } from "./handoff.ts";
import { checkDesignDoc, docAtCommit, parseScope, sectionText, type ChairPick, type DesignManifest } from "./design.ts";

// Neutral synthetic data only: no real game, genre, mechanic, or title from the studio's runs.
// Shape follows the real Chair output: `pick` plus top-level `rejected` and `risks_to_watch`.
const ITEM_A = "Assembly table UI: place pieces on the board grid, rotate, highlight-on-hover";
const ITEM_B = "Scoring resolver: per-piece trigger table read from data";
const CONDITION = "No rotation in the placement layer: pieces are fixed tiles (Critic's major fix).";
const chairOut = {
  pick: {
    working_title: "Alpha Tray",
    why: "Best buildability and the strongest want coverage of the survivors.",
    adopted_must: [
      { item: ITEM_A, critic_hours: 3.5 },
      { item: ITEM_B, critic_hours: 2.5 },
    ],
    deferred: ["Bonus layout mode (2h): deferred because the two adopted items are the skeleton and total exactly 6h"],
    art_and_qa: ["Art: 6-frame animation set reused across all pieces.", "QA: every trigger fires in every grid position."],
    conditions: [CONDITION],
  },
  rejected: [{ working_title: "Beta Board", why_not: "Weakest feasibility and a 12h must list needing deep cuts." }],
  risks_to_watch: ["If one layout dominates, retune before adding content."],
};
// What designTask embeds and the eval checks against.
const pick: ChairPick = { ...chairOut.pick, risks_to_watch: chairOut.risks_to_watch, rejected: chairOut.rejected };

const pitch = {
  working_title: "Alpha Tray",
  gap_label: "Gap One",
  wants_addressed: [{ want: "I want to plan without a clock", how: "Untimed placement" }],
  animation_budget: { animated_characters: 2, frames_per_character: 3, notes: "" },
  scope: { must: chairOut.pick.adopted_must.map((m) => ({ item: m.item, hours: m.critic_hours })), should: ["Bonus layout mode"], could: [] },
};

/** A runs/ tree: player-voice brief, director run, loop, and the Chair run that picked. */
function makeRunsRoot(): { root: string; chairDir: string } {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "anyco-design-")), "runs");
  for (const d of ["pv", "gd", "greenlight-t1", "chair"]) mkdirSync(path.join(root, d), { recursive: true });
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
  writeFileSync(path.join(root, "chair", "run.json"), JSON.stringify({ task: "Greenlight pick: choose the game.\nRefs: director run gd, critic run gc, loop greenlight-t1." }));
  writeFileSync(path.join(root, "chair", "output.json"), JSON.stringify(chairOut));
  return { root, chairDir: "chair" };
}

test("designTask builds the design brief from the real Chair output shape", () => {
  const { root, chairDir } = makeRunsRoot();
  const task = designTask(chairDir, root);
  const blocks = [...task.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 2);
  // R9-4: top-level rejected + risks_to_watch are embedded on the pick, so the doc checks see them
  assert.deepEqual(blocks[0], pick);
  assert.deepEqual(blocks[0].rejected, chairOut.rejected);
  assert.deepEqual(blocks[1], pitch);
  assert.match(task, /Refs: chair run chair, loop greenlight-t1, director run gd, brief runs\/pv\/handoff-pitches\.md\./);
  assert.match(task, /- I want to plan without a clock \(57% of 120 negative reviews/);
  assert.match(task, /exactly the Chair's adopted_must items and hours \(6h total/);
  assert.match(task, /Conditions override item text/);
  // and a doc that brings a rejected title back is flagged using the embedded pick
  const back = goodDoc.replace("One paragraph about the chosen game.", "One paragraph, borrowing from Beta Board.");
  assert.match(checkDesignDoc(back, blocks[0], goodOut).join("\n"), /rejected pitch "Beta Board" appears/);
  // T13: a numbered brief and a want cited by id resolve to the full sized line
  writeFileSync(
    path.join(root, "pv", "handoff-pitches.md"),
    ["## Gap One", "Wants:", "- [W1] I want to plan without a clock (57% of 120 negative reviews of appid 1 mention \"timer\") — pressure kills the fun.", ""].join("\n"),
  );
  writeFileSync(path.join(root, "gd", "output.json"), JSON.stringify({ pitches: [{ ...pitch, wants_addressed: [{ want: "W1", how: "Untimed placement" }] }] }));
  assert.match(designTask(chairDir, root), /^- \[W1\] I want to plan without a clock \(57% of 120 negative reviews/m);
  writeFileSync(path.join(root, "gd", "output.json"), JSON.stringify({ pitches: [pitch, { ...pitch, working_title: "Beta Board" }] }));
  // a pick that is not in the final round is a hard error, not a guess
  writeFileSync(path.join(root, "chair", "output.json"), JSON.stringify({ ...chairOut, pick: { ...chairOut.pick, working_title: "No Such Pitch" } }));
  assert.throws(() => designTask(chairDir, root), /No Such Pitch/);
  rmSync(path.dirname(root), { recursive: true, force: true });
});

// A compliant doc, written the way a model is likely to: standard markdown tables with header
// and separator rows, and the condition overriding ITEM_A's rotation in Systems.
const goodDoc = [
  "## Pitch",
  "One paragraph about the chosen game.",
  "## Core loop",
  "1. Read the table. 2. Place pieces. 3. Resolve.",
  "## Scope",
  "### Must",
  "| Item | Hours |",
  "|------|-------|",
  `| ${ITEM_A} | 3.5 |`,
  `| ${ITEM_B} | 2.5 |`,
  "### Should",
  "| Item | Hours |",
  "|---|---|",
  "| Bonus layout mode | 2 |",
  "### Could",
  "| Item | Hours |",
  "|:---|---:|",
  "| Daily layouts | - |",
  "## Conditions",
  `- ${CONDITION}`,
  "## Systems",
  `### ${ITEM_A}`,
  "Drag, drop, highlight. Reads piece definitions from content/pieces.json.",
  "Per condition: No rotation in the placement layer — pieces are fixed tiles; no rotate input is built.",
  `### ${ITEM_B}`,
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
  branch: "agent/game-design-director",
  commit: "0123456789abcdef",
  doc_path: "docs/design.md",
  should_count: 1,
  could_count: 1,
  data_files: [{ path: "content/pieces.json", what: "piece definitions" }, { path: "content/triggers.json", what: "trigger table" }],
};

test("a compliant doc with standard markdown tables passes every check", () => {
  assert.deepEqual(checkDesignDoc(goodDoc, pick, goodOut), []);
  const scope = parseScope(sectionText(goodDoc, "Scope"));
  assert.deepEqual(scope.must, [{ item: ITEM_A, hours: 3.5 }, { item: ITEM_B, hours: 2.5 }]);
  assert.deepEqual(scope.should, ["Bonus layout mode"]);
  assert.deepEqual(scope.could, ["Daily layouts"]);
});

test("R9-2: '4h' / '4 h' hours and extra columns parse; separators never become rows", () => {
  const scope = parseScope(["### Must", "| Item | Hours | Notes |", "| --- | --- | --- |", "| One | 4h | x |", "| Two | 1.5 h | y |"].join("\n"));
  assert.deepEqual(scope.must, [{ item: "One", hours: 4 }, { item: "Two", hours: 1.5 }]);
});

test("R9-1: conditions override item text and must be applied in Systems", () => {
  // the item text still says "rotate"; the Systems subsection follows the condition: passes (goodDoc)
  assert.ok(goodDoc.includes(`| ${ITEM_A} | 3.5 |`));
  // a Systems subsection that still builds the removed feature without a "Per condition" line fails
  const ignores = goodDoc.replace(
    "Per condition: No rotation in the placement layer — pieces are fixed tiles; no rotate input is built.",
    "Rotate pieces with the R key in 90-degree steps.",
  );
  assert.match(checkDesignDoc(ignores, pick, goodOut).join("\n"), /condition not applied in Systems/);
  // quoting the condition verbatim inside Systems also counts
  const quoted = ignores.replace("Rotate pieces with the R key in 90-degree steps.", `Follows: ${CONDITION}`);
  assert.deepEqual(checkDesignDoc(quoted, pick, goodOut), []);
  // an empty "Per condition:" line does not satisfy every condition
  const empty = ignores.replace("Rotate pieces with the R key in 90-degree steps.", "Per condition:");
  assert.match(checkDesignDoc(empty, pick, goodOut).join("\n"), /condition not applied in Systems/);
  // every Must item needs its own Systems subsection
  assert.match(checkDesignDoc(goodDoc.replace(`### ${ITEM_B}\n`, ""), pick, goodOut).join("\n"), /Systems has no "### Scoring resolver/);
});

test("R9-3: a Should table without the deferred items fails even with a separator row", () => {
  const doc = goodDoc.replace("| Bonus layout mode | 2 |", "| Something unrelated | 2 |");
  assert.match(checkDesignDoc(doc, pick, goodOut).join("\n"), /deferred item "Bonus layout mode/);
  const onlySeparator = goodDoc.replace("| Item | Hours |\n|---|---|\n| Bonus layout mode | 2 |", "|---|---|");
  assert.match(checkDesignDoc(onlySeparator, pick, { ...goodOut, should_count: 0 }).join("\n"), /deferred item "Bonus layout mode/);
});

test("R9-6: data files must match in both directions", () => {
  const extra = goodDoc.replace("## Balance targets", "### content/extra.json\nEntity type extra: id (string), count target 3.\n## Balance targets");
  assert.match(checkDesignDoc(extra, pick, goodOut).join("\n"), /data file "content\/extra\.json" is under "## Content as data" but not in the manifest/);
  const missing = goodDoc.replace("### content/pieces.json", "### content/other.json");
  assert.match(checkDesignDoc(missing, pick, goodOut).join("\n"), /data file "content\/pieces\.json".*not under "## Content as data"/);
});

test("R9-7: non-numeric Must hours are flagged, never a silent NaN total", () => {
  const doc = goodDoc.replace(`| ${ITEM_B} | 2.5 |`, `| ${ITEM_B} | TBD |`);
  assert.match(checkDesignDoc(doc, pick, goodOut).join("\n"), /hours "NaN" is not a number/);
  // and an over-budget table still trips the budget when every value is a number
  const over = goodDoc.replace(`| ${ITEM_B} | 2.5 |`, `| ${ITEM_B} | 9 |`);
  assert.match(checkDesignDoc(over, pick, goodOut).join("\n"), /Must table totals 12\.5h > 10h/);
});

test("other hard rules fail loudly when broken", () => {
  const broken: Array<[string, RegExp, DesignManifest?]> = [
    [goodDoc.replace("## Balance targets", "## Targets"), /missing section "## Balance targets"/],
    [goodDoc.replace(`| ${ITEM_B} | 2.5 |`, `| ${ITEM_B} | 5 |`), /5h in the doc vs the Chair's 2\.5h/],
    [goodDoc.replace(`- ${CONDITION}`, "- No turning at all."), /condition not copied verbatim/],
    [goodDoc.replace(`| ${ITEM_B} | 2.5 |\n`, `| ${ITEM_B} | 2.5 |\n| Sneaky extra system | 4 |\n`), /Must table adds "Sneaky extra system/],
    [goodDoc.replace("One paragraph about the chosen game.", "One paragraph, unlike Beta Board."), /rejected pitch "Beta Board" appears/],
    [goodDoc, /should_count 2 vs 1/, { ...goodOut, should_count: 2 }],
  ];
  for (const [doc, re, out = goodOut] of broken) assert.match(checkDesignDoc(doc, pick, out).join("\n"), re);
});

test("docAtCommit reads the doc at the reported commit, only from the reported branch (R9-5)", () => {
  const clone = mkdtempSync(path.join(tmpdir(), "anyco-clone-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { env, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch", "main");
  writeFileSync(path.join(clone, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  git("checkout", "--quiet", "-b", "agent/game-design-director");
  mkdirSync(path.join(clone, "docs"));
  writeFileSync(path.join(clone, "docs", "design.md"), goodDoc);
  git("add", "-A");
  git("commit", "--quiet", "-m", "design doc");
  const sha = git("rev-parse", "HEAD").trim();
  // a commit on some other branch, with its own design.md
  git("checkout", "--quiet", "-b", "elsewhere", "main");
  mkdirSync(path.join(clone, "docs"), { recursive: true });
  writeFileSync(path.join(clone, "docs", "design.md"), "## Pitch\nnot the agent's\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "other");
  const other = git("rev-parse", "HEAD").trim();

  const branch = "agent/game-design-director";
  assert.equal(docAtCommit(clone, sha, "docs/design.md", branch).doc, goodDoc);
  assert.equal(docAtCommit(clone, sha.slice(0, 10), "docs/design.md", branch).doc, goodDoc); // short sha
  assert.match(docAtCommit(clone, other, "docs/design.md", branch).error ?? "", /not on branch agent\/game-design-director/);
  assert.match(docAtCommit(clone, sha, "docs/design.md", "agent/nobody").error ?? "", /branch agent\/nobody is not in the clone/);
  assert.match(docAtCommit(clone, "deadbeef", "docs/design.md", branch).error ?? "", /deadbeef/);
  assert.match(docAtCommit(clone, sha, "docs/missing.md", branch).error ?? "", /missing/);
  rmSync(clone, { recursive: true, force: true });
});
