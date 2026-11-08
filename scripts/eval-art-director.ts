// Mechanical eval of an art-director run. Usage: npm run eval:art-director -- runs/<run_id>
// Re-runs art_gate on the run's game clone and checks every number and verdict the agent
// reported; checks the style bible declares grid/palette/outline/light; checks the
// manifest palette equals the style bible's.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGate, type GateReport } from "../tools/art/gate.ts";

export interface EvalSummary {
  run_id: string;
  agent: string;
  status: string;
  checks_passed: string;
  pass: boolean;
  issues: string[];
}

/** Parse the style bible's four required declarations (`- grid:`, `- palette:`, `- outline:`, `- light:`). */
export function parseStyleBible(text: string): { grid?: string; palette?: string[]; outline?: string; light?: string } {
  const out: { grid?: string; palette?: string[]; outline?: string; light?: string } = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s*(grid|palette|outline|light):\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "palette") out.palette = m[2].split(/[,\s]+/).filter(Boolean).map((c) => c.toLowerCase());
    else if (key === "grid") out.grid = m[2];
    else if (key === "outline") out.outline = m[2];
    else if (key === "light") out.light = m[2];
  }
  return out;
}

export function evalDirector(dir: string): EvalSummary {
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as { run_id: string; agent?: string; status: string };
  const out = JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8")) as {
    style_bible: string;
    manifest: { locked: boolean; grid: { w: number; h: number }; palette: string[] };
    anchors: Array<{ id: string }>;
    assets: Array<{ id: string; pass: boolean; verdict: string; offPaletteShare: number; maxFrameDrift: number | null; anchorDrift: number | null }>;
  };
  const issues: string[] = [];
  let checks = 0;
  const check = (cond: boolean, msg: string) => {
    checks++;
    if (!cond) issues.push(msg);
  };

  const clone = path.join(dir, "workspace", "game");
  let manifestAssets: Array<{ id: string; anim?: { mode?: string } }> | null = null;
  check(existsSync(clone), "no game clone at workspace/game (game_clone before reporting)");
  const biblePath = path.join(clone, ...out.style_bible.split("/"));
  check(existsSync(biblePath), `style bible ${out.style_bible} not found in the clone`);
  if (existsSync(biblePath)) {
    const bible = parseStyleBible(readFileSync(biblePath, "utf8"));
    check(!!bible.grid, "style bible does not declare `- grid:`");
    check(!!bible.palette, "style bible does not declare `- palette:`");
    check(!!bible.outline, "style bible does not declare `- outline:`");
    check(!!bible.light, "style bible does not declare `- light:`");
    // Compare against the clone's REAL manifest, not what the agent reported. Palettes compare
    // exactly (same colors, same order, case-insensitive): the bible's order is the lock order.
    const manifestPath = path.join(clone, "assets", "manifest.json");
    let real: { grid?: { w: number; h: number }; palette?: string[]; assets?: Array<{ id: string; anim?: { mode?: string } }> } | null = null;
    try {
      real = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      real = null;
    }
      check(real !== null, "clone has no readable assets/manifest.json");
    if (real) {
      const realAssets = real.assets ?? null;
      manifestAssets = realAssets;
      const realPalette = (real.palette ?? []).map((c) => c.toLowerCase());
      const realGrid = real.grid ? `${real.grid.w}x${real.grid.h}` : "none";
      check(!!bible.palette && JSON.stringify(bible.palette) === JSON.stringify(realPalette), `real manifest palette [${realPalette.join(", ")}] ≠ style bible palette [${(bible.palette ?? []).join(", ")}]`);
      check(!!bible.grid && bible.grid.replace(/\s/g, "").toLowerCase() === realGrid, `real manifest grid ${realGrid} ≠ style bible grid ${bible.grid}`);
      const reported = out.manifest;
      check(
        reported.locked === (realPalette.length >= 2 && !!real.grid) &&
          JSON.stringify(reported.palette.map((c) => c.toLowerCase())) === JSON.stringify(realPalette) &&
          reported.grid.w === real.grid?.w && reported.grid.h === real.grid?.h,
        "reported manifest (locked/grid/palette) ≠ the clone's real manifest",
      );
    }
  }

  let gate: GateReport | null = null;
  if (existsSync(clone)) {
    gate = runGate(clone);
    check(gate.manifest.valid, `manifest fails schema: ${gate.manifest.errors.slice(0, 2).join("; ")}`);
    // the gate's whole-repo verdict, not just per-asset numbers
    check(gate.files.missing.length === 0, `gate: manifest paths missing on disk: ${gate.files.missing.join(", ")}`);
    check(gate.files.unlisted.length === 0, `gate: unlisted files under assets/: ${gate.files.unlisted.join(", ")}`);
    check(gate.files.symlinks.length === 0, `gate: symlinks under assets/: ${gate.files.symlinks.join(", ")}`);
    const freshIds = new Set(gate.assets.map((a) => a.id));
    const reportedIds = new Set(out.assets.map((a) => a.id));
    check(out.assets.length >= freshIds.size && [...freshIds].every((id) => reportedIds.has(id)), "reported assets do not cover every manifest asset");
    for (const reported of out.assets) {
      const fresh = gate.assets.find((a) => a.id === reported.id);
      check(!!fresh, `asset "${reported.id}" is not in the gate report`);
      if (!fresh) continue;
      check(reported.pass === fresh.pass, `asset "${reported.id}": reported pass=${reported.pass} but the gate says ${fresh.pass}`);
      const eps = 1e-9;
      check(Math.abs((reported.offPaletteShare ?? -1) - (fresh.numbers.offPaletteShare ?? -1)) < eps, `asset "${reported.id}": offPaletteShare ${reported.offPaletteShare} ≠ gate ${(fresh.numbers.offPaletteShare ?? 0).toFixed(4)}`);
      const freshFrame = fresh.numbers.frameDrift && fresh.numbers.frameDrift.length > 0 ? Math.max(...fresh.numbers.frameDrift) : null;
      check(Math.abs((reported.maxFrameDrift ?? -1) - (freshFrame ?? -1)) < eps, `asset "${reported.id}": maxFrameDrift ${reported.maxFrameDrift} ≠ gate ${freshFrame}`);
      check((reported.anchorDrift ?? null) === (fresh.numbers.anchorDrift ?? null) || Math.abs((reported.anchorDrift ?? -1) - (fresh.numbers.anchorDrift ?? -1)) < eps, `asset "${reported.id}": anchorDrift ${reported.anchorDrift} ≠ gate ${fresh.numbers.anchorDrift}`);
      check(!(reported.verdict === "approve" && !fresh.pass), `asset "${reported.id}": approved although the gate fails`);
      // Fallback floor (T18): a cut asset marked anim.mode "procedural" is a pass — simple shapes
      // animated in engine are the guaranteed outcome when generation fails or the cap hits.
      if (reported.verdict === "cut") {
        const manifestAsset = manifestAssets?.find((a) => a.id === reported.id);
        check(manifestAsset?.anim?.mode === "procedural", `asset "${reported.id}": cut but the manifest does not mark anim.mode "procedural" (the floor is a pass only there)`);
      }
    }
  }

  const summary: EvalSummary = {
    run_id: run.run_id,
    agent: run.agent ?? "art-director",
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
    console.error("usage: npm run eval:art-director -- runs/<run_id>");
    process.exit(2);
  }
  const summary = evalDirector(dir);
  console.log(JSON.stringify({ ...summary, issues: undefined }, null, 2));
  for (const issue of summary.issues) console.log(`  ! ${issue}`);
  process.exitCode = summary.pass ? 0 : 1;
}
