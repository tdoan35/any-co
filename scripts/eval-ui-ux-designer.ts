// Mechanical eval of a ui-ux-designer run. Usage: npm run eval:ui-ux-designer -- runs/<run_id>
// Checks the clone's docs/ui-spec.md carries every required section (and the sections the agent claimed),
// every finding cites a frame that exists in the run (with a rect inside it) and an element, severities come
// from the enum, findings are ranked, and the run's agent branch changed no file besides docs/ui-spec.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodePng } from "../tools/art/png.ts";
import { UI_SEVERITIES, UI_SPEC_SECTIONS } from "../agents/ui-ux-designer/spec.ts";

export interface EvalSummary { run_id: string; agent: string; status: string; checks_passed: string; pass: boolean; issues: string[] }

interface Output {
  spec: { path: string; sections: string[]; commit: string };
  frames?: string[];
  findings: Array<{ severity: string; frame: string; element: string; rect?: [number, number, number, number] }>;
}

/** `## ` headings of a markdown file, trimmed, case-insensitive compare. */
export function headings(md: string): string[] {
  return md.split("\n").map((l) => /^##\s+(.+?)\s*#*\s*$/.exec(l)?.[1]).filter((h): h is string => !!h);
}

export function evalUiUx(dir: string): EvalSummary {
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as { run_id: string; agent?: string; status: string; output?: Output };
  const out = (existsSync(path.join(dir, "output.json")) ? JSON.parse(readFileSync(path.join(dir, "output.json"), "utf8")) : run.output) as Output;
  const issues: string[] = [];
  let checks = 0;
  const check = (cond: boolean, msg: string) => {
    checks++;
    if (!cond) issues.push(msg);
  };
  const workspace = path.join(dir, "workspace");
  const clone = path.join(workspace, "game");
  const specFile = path.join(clone, "docs", "ui-spec.md");

  check(!!out, "no output (run.json output / output.json)");
  if (!out) return finish(dir, run, checks, issues);
  check(existsSync(specFile), "docs/ui-spec.md is not in the run's game clone");
  if (existsSync(specFile)) {
    const have = headings(readFileSync(specFile, "utf8")).map((h) => h.toLowerCase());
    for (const s of UI_SPEC_SECTIONS) check(have.includes(s.toLowerCase()), `docs/ui-spec.md lacks the required section "## ${s}"`);
    for (const s of out.spec.sections) check(have.includes(s.toLowerCase()), `output claims section "${s}" but docs/ui-spec.md has no "## ${s}"`);
  }

  const rank = new Map(UI_SEVERITIES.map((s, i) => [s as string, i]));
  let last = -1;
  for (const [i, f] of out.findings.entries()) {
    const tag = `finding ${i + 1} (${f.element || "?"})`;
    check(rank.has(f.severity), `${tag}: severity "${f.severity}" is not one of ${UI_SEVERITIES.join(", ")}`);
    check((rank.get(f.severity) ?? 99) >= last, `${tag}: findings are not ranked most severe first`);
    last = Math.max(last, rank.get(f.severity) ?? last);
    check(typeof f.element === "string" && f.element.trim().length > 0, `${tag}: no element`);
    const norm = path.posix.normalize(String(f.frame ?? "").replace(/\\/g, "/"));
    const safe = norm.length > 0 && !norm.startsWith("../") && !path.isAbsolute(norm);
    const abs = path.join(workspace, norm);
    check(safe && existsSync(abs), `${tag}: frame "${f.frame}" does not exist in the run workspace`);
    if (safe && existsSync(abs) && f.rect && abs.endsWith(".png")) {
      try {
        const img = decodePng(new Uint8Array(readFileSync(abs)));
        const [x, y, w, h] = f.rect;
        check(x + w <= img.width && y + h <= img.height, `${tag}: rect [${f.rect.join(", ")}] falls outside the ${img.width}x${img.height} frame`);
      } catch {
        check(false, `${tag}: frame "${f.frame}" is not a decodable PNG`);
      }
    }
  }

  // Writes stay inside docs/ui-spec.md: every commit the run added on its branch (vs origin/main) touches only it.
  if (existsSync(path.join(clone, ".git"))) {
    try {
      const changed = execFileSync("git", ["-C", clone, "diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
      const stray = changed.filter((f) => f !== "docs/ui-spec.md");
      check(stray.length === 0, `the agent branch changed files besides docs/ui-spec.md: ${stray.slice(0, 5).join(", ")}`);
    } catch (e) {
      check(false, `could not diff the clone against origin/main: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return finish(dir, run, checks, issues);
}

function finish(dir: string, run: { run_id: string; agent?: string; status: string }, checks: number, issues: string[]): EvalSummary {
  const summary: EvalSummary = { run_id: run.run_id, agent: run.agent ?? "ui-ux-designer", status: run.status, checks_passed: `${checks - issues.length}/${checks}`, pass: issues.length === 0, issues };
  writeFileSync(path.join(dir, "eval.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !existsSync(path.join(dir, "run.json"))) {
    console.error("usage: npm run eval:ui-ux-designer -- runs/<run_id>");
    process.exit(2);
  }
  const summary = evalUiUx(dir);
  console.log(JSON.stringify({ ...summary, issues: undefined }, null, 2));
  for (const issue of summary.issues) console.log(`  ! ${issue}`);
  process.exitCode = summary.pass ? 0 : 1;
}
