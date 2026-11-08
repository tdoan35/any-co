import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, makeImage } from "../tools/art/png.ts";
import { evalUiUx, headings } from "./eval-ui-ux-designer.ts";
import { UI_SPEC_SECTIONS } from "../agents/ui-ux-designer/spec.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const SPEC = UI_SPEC_SECTIONS.map((s) => `## ${s}\n\ntext\n`).join("\n");

/** A run dir: run.json + output.json, a clone on an agent branch off origin/main, and one 320x180 frame. */
function runDir(o: { spec?: string; findings?: unknown[]; sections?: string[]; stray?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "uiux-eval-"));
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const clone = path.join(dir, "workspace", "game");
  git(dir, "clone", "-q", origin, clone);
  writeFileSync(path.join(clone, "README.md"), "game\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "init");
  git(clone, "push", "-q", "origin", "HEAD:main");
  git(clone, "fetch", "-q", "origin");
  git(clone, "checkout", "-q", "-b", "agent/ui-ux-designer");
  mkdirSync(path.join(clone, "docs"), { recursive: true });
  writeFileSync(path.join(clone, "docs", "ui-spec.md"), o.spec ?? SPEC);
  if (o.stray) writeFileSync(path.join(clone, "main.gd"), "extends Node\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "ui spec");
  mkdirSync(path.join(dir, "workspace", "media", "export-frames", "web-index"), { recursive: true });
  writeFileSync(path.join(dir, "workspace", "media", "export-frames", "web-index", "frame-0089.png"), encodePng(makeImage(320, 180)));
  const output = {
    complete: true,
    spec: { path: "docs/ui-spec.md", sections: o.sections ?? [...UI_SPEC_SECTIONS], commit: "abc" },
    build_id: "b1",
    frames: ["media/export-frames/web-index/frame-0089.png"],
    findings: o.findings ?? [
      { severity: "major", frame: "media/export-frames/web-index/frame-0089.png", element: "hud.health", rect: [0, 0, 64, 16], problem: "health is unreadable on the bright sky", suggested_fix: "panel behind it per Panel style" },
      { severity: "polish", frame: "media/export-frames/web-index/frame-0089.png", element: "shop.reroll", problem: "button sits off the 8 px spacing grid", suggested_fix: "snap to the Spacing grid unit" },
    ],
    summary: "s",
  };
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: "r1", agent: "ui-ux-designer", status: "done", output }));
  writeFileSync(path.join(dir, "output.json"), JSON.stringify(output));
  return dir;
}

test("eval ui-ux-designer: a complete spec and well-cited, ranked findings pass", () => {
  const s = evalUiUx(runDir());
  assert.equal(s.pass, true, s.issues.join("\n"));
  assert.deepEqual(headings("## A\ntext\n##  B ##\n### C"), ["A", "B"]);
});

test("eval ui-ux-designer: missing sections, uncited or missing frames, bad severities, unranked, rect outside, stray writes all fail", () => {
  const missing = evalUiUx(runDir({ spec: "## Screen regions\n\n## Type scale\n" }));
  assert.equal(missing.pass, false);
  assert.ok(missing.issues.some((i) => /lacks the required section "## Visual hierarchy"/.test(i)), missing.issues.join("\n"));

  const bad = evalUiUx(runDir({
    findings: [
      { severity: "minor", frame: "media/export-frames/web-index/frame-0089.png", element: "a", problem: "p", suggested_fix: "f" },
      { severity: "blocker", frame: "media/nope.png", element: "b", problem: "p", suggested_fix: "f" },
      { severity: "critical", frame: "../../etc/hosts", element: "", problem: "p", suggested_fix: "f" },
      { severity: "polish", frame: "media/export-frames/web-index/frame-0089.png", element: "c", rect: [300, 170, 64, 16], problem: "p", suggested_fix: "f" },
    ],
  }));
  const all = bad.issues.join("\n");
  assert.match(all, /finding 2 \(b\): findings are not ranked/);
  assert.match(all, /finding 2 \(b\): frame "media\/nope.png" does not exist/);
  assert.match(all, /finding 3 \(\?\): severity "critical" is not one of/);
  assert.match(all, /finding 3 \(\?\): no element/);
  assert.match(all, /finding 3 \(\?\): frame "..\/..\/etc\/hosts" does not exist/);
  assert.match(all, /finding 4 \(c\): rect \[300, 170, 64, 16\] falls outside the 320x180 frame/);

  const stray = evalUiUx(runDir({ stray: true }));
  assert.match(stray.issues.join("\n"), /changed files besides docs\/ui-spec.md: main.gd/);
});
