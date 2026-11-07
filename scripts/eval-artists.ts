// Shared mechanical eval for the two artist agents (sprite-artist, env-ui-artist).
// Usage: npm run eval:sprite-artist -- runs/<run_id>   (same script for env-ui-artist)
// Re-runs art_gate on the run's game clone and checks the agent copied its verdict;
// every reported output file exists and every in-manifest asset is really in the manifest.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "../tools/art/gate.ts";
import type { EvalSummary } from "./eval-art-director.ts";

export function evalArtists(dir: string): EvalSummary {
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as { run_id: string; agent?: string; status: string };
  const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8")) as {
    generated: Array<{ id: string; path: string; provider: string; frames: number; in_manifest: boolean }>;
    gate: { ok: boolean; failed: string[] };
    spent_usd: number;
  };
  const issues: string[] = [];
  let checks = 0;
  const check = (cond: boolean, msg: string) => {
    checks++;
    if (!cond) issues.push(msg);
  };

  const workspace = path.join(dir, "workspace");
  const clone = path.join(workspace, "game");
  check(existsSync(clone), "no game clone at workspace/game (game_clone before generating)");
  check(out.generated.length > 0, "no generated assets reported");

  for (const asset of out.generated) {
    const file = path.join(workspace, ...asset.path.split("/"));
    check(existsSync(file), `generated file "${asset.path}" does not exist in the workspace`);
  }

  if (existsSync(clone)) {
    const gate = runGate(clone);
    const failing = gate.assets.filter((a) => !a.pass).map((a) => a.id).sort();
    check(out.gate.ok === gate.ok, `reported gate ok=${out.gate.ok} but re-running art_gate says ${gate.ok}`);
    check(JSON.stringify([...out.gate.failed].sort()) === JSON.stringify(failing), `reported failing ids [${out.gate.failed.join(", ")}] ≠ gate [${failing.join(", ")}]`);
    const ids = new Set(gate.assets.map((a) => a.id));
    for (const asset of out.generated.filter((g) => g.in_manifest)) check(ids.has(asset.id), `asset "${asset.id}" claimed in_manifest but the gate report has no such id`);
  }

  check(Number.isFinite(out.spent_usd) && out.spent_usd >= 0, `spent_usd ${out.spent_usd} is not a non-negative number`);
  check(out.generated.length === 0 || out.spent_usd > 0, "generated assets but spent_usd is 0 — paid calls never cost nothing");

  const summary: EvalSummary = {
    run_id: run.run_id,
    agent: run.agent ?? "artist",
    status: run.status,
    checks_passed: `${checks - issues.length}/${checks}`,
    pass: issues.length === 0,
    issues,
  };
  writeFileSync(path.join(dir, "eval.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !existsSync(path.join(dir, "run.json"))) {
    console.error("usage: node --import tsx scripts/eval-artists.ts runs/<run_id>");
    process.exit(2);
  }
  const summary = evalArtists(dir);
  console.log(JSON.stringify({ ...summary, issues: undefined }, null, 2));
  for (const issue of summary.issues) console.log(`  ! ${issue}`);
  process.exitCode = summary.pass ? 0 : 1;
}
