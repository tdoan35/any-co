// Shared mechanical eval for the two artist agents (sprite-artist, env-ui-artist).
// Usage: npm run eval:sprite-artist -- runs/<run_id>   (same script for env-ui-artist)
// Re-runs art_gate on the run's game clone and checks the agent copied its verdict;
// every reported output file exists and every in-manifest asset is really in the manifest.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "../tools/art/gate.ts";
import type { EvalSummary } from "./eval-art-director.ts";

/** Sum of art_generate tool charges for this run in runs/spend.jsonl (sibling of the run dir), or null. */
function artSpendUsd(dir: string, runId: string): number | null {
  const ledger = path.join(path.dirname(dir), "spend.jsonl");
  if (!existsSync(ledger)) return null;
  let micro = 0;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { run_id?: string; kind?: string; what?: string; micro_usd?: number };
      if (e.run_id === runId && e.kind === "tool" && e.what === "art_generate") micro += e.micro_usd ?? 0;
    } catch {
      // torn line
    }
  }
  return micro / 1e6;
}

export function evalArtists(dir: string): EvalSummary {
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as { run_id: string; agent?: string; status: string; spent_micro_usd?: number };
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
  // The runner records every charge (model + tools) in run.json spent_micro_usd. Art spend is a
  // part of it, so the claim may not exceed the run total; when the run spent mostly on art
  // (as artists do) the claim must cover all tool spend recorded in spend.jsonl for this run.
  if (typeof run.spent_micro_usd === "number") {
    const runUsd = run.spent_micro_usd / 1e6;
    const toolUsd = artSpendUsd(dir, run.run_id);
    const floor = toolUsd ?? 0;
    check(
      out.spent_usd <= runUsd + 0.005 && out.spent_usd + 0.005 >= floor,
      `reported spent_usd ${out.spent_usd} vs the run's recorded spend ${runUsd.toFixed(4)} (art_generate tool spend ${toolUsd === null ? "unknown" : toolUsd.toFixed(4)})`,
    );
    if (toolUsd === null)
      check(out.spent_usd + 0.005 >= runUsd * 0.5, `reported spent_usd ${out.spent_usd} is far below the run's recorded spend ${runUsd.toFixed(4)} (no spend.jsonl to split tool spend)`);
  }

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
