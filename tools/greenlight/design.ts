// Design-doc checks: the Game Director's design.md has fixed section names so code can check
// it (agents/game-director-design). Everything here is pure and tested on neutral fixtures;
// the eval script (scripts/eval-game-director-design.ts) wires these to a real run + clone.
import { execFileSync } from "node:child_process";
import { MUST_HOURS_BUDGET } from "./feasibility.ts";

// Heading text is law: the eval and downstream agents (Tech Lead, Level/Content Designer,
// art, QA) find their sections by these exact `## <name>` lines.
export const REQUIRED_SECTIONS = [
  "Pitch",
  "Core loop",
  "Scope",
  "Conditions",
  "Systems",
  "Content as data",
  "Balance targets",
  "Art needs",
  "Out of scope",
] as const;

/** Text of one `## <name>` section, up to the next `## ` heading (heading line excluded). */
export function sectionText(doc: string, name: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n").trim();
}

export interface MustRow {
  item: string;
  hours: number;
}

/** Parse the `### Must` / `### Should` / `### Could` tables inside the Scope section. */
export function parseScope(scope: string): { must: MustRow[]; should: string[]; could: string[] } {
  const subsection = (name: string) => {
    const lines = scope.split("\n");
    const start = lines.findIndex((l) => l.trim() === `### ${name}`);
    if (start === -1) return "";
    const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
    return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
  };
  const rows = (text: string) =>
    [...text.matchAll(/^\|\s*(.+?)\s*\|\s*([-\d.]+)\s*\|\s*$/gm)].map((m) => ({ item: m[1], hours: m[2] }));
  const must = rows(subsection("Must"))
    .filter((r) => r.hours !== "-")
    .map((r) => ({ item: r.item, hours: Number(r.hours) }));
  // Should rows may carry hours (`| item | 2 |`) or not (`| item | - |`); only the item matters.
  const items = (name: string) => rows(subsection(name)).map((r) => r.item);
  return { must, should: items("Should"), could: items("Could") };
}

/** Lowercased, punctuation-free text: wording may differ in punctuation, not in words. */
const norm = (s: string) =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\((?:[^()]*)\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The deferred item itself, without the Chair's trailing reason (": because ..."). */
export const deferredItem = (d: string) => norm(String(d).split(":")[0]);

export interface DesignManifest {
  branch?: string;
  commit?: string;
  doc_path?: string;
  must?: MustRow[];
  should_count?: number;
  could_count?: number;
  data_files?: Array<{ path: string; what?: string }>;
}

/** The Greenlight Chair's output (agents/greenlight-chair): the pick the design doc answers to. */
export interface ChairPick {
  working_title?: string;
  why?: string;
  adopted_must?: Array<{ item: string; critic_hours: number }>;
  deferred?: string[];
  art_and_qa?: string[];
  conditions?: string[];
  rejected?: Array<{ working_title: string; why_not: string }>;
  risks_to_watch?: string[];
}
/**
 * Check a design doc against the Chair's pick (as embedded in the task by designTask) and
 * the agent's manifest. Returns one issue string per violation; empty means the doc is good.
 */
export function checkDesignDoc(doc: string, pick: ChairPick, out: DesignManifest): string[] {
  const issues: string[] = [];
  for (const s of REQUIRED_SECTIONS) if (!new RegExp(`^## ${s}\\s*$`, "m").test(doc)) issues.push(`missing section "## ${s}"`);
  const scope = parseScope(sectionText(doc, "Scope"));
  const adopted: Array<{ item: string; critic_hours: number }> = pick?.adopted_must ?? [];
  if (scope.must.length !== adopted.length)
    issues.push(`Must table has ${scope.must.length} rows; the Chair adopted ${adopted.length}`);
  for (const m of adopted) {
    const row = scope.must.find((r) => r.item.trim() === m.item.trim());
    if (!row) issues.push(`Must table is missing the adopted item "${m.item.slice(0, 60)}"`);
    else if (Math.abs(row.hours - m.critic_hours) > 1e-6) issues.push(`"${m.item.slice(0, 40)}": ${row.hours}h in the doc vs the Chair's ${m.critic_hours}h`);
  }
  const total = scope.must.reduce((s, m) => s + m.hours, 0);
  if (total > MUST_HOURS_BUDGET) issues.push(`Must table totals ${total}h > ${MUST_HOURS_BUDGET}h`);
  for (const m of scope.must) if (!adopted.some((a) => a.item.trim() === m.item.trim())) issues.push(`Must table adds "${m.item.slice(0, 60)}", which the Chair did not adopt`);

  const conditions: string[] = pick?.conditions ?? [];
  const cond = sectionText(doc, "Conditions");
  for (const c of conditions) if (!cond.includes(c)) issues.push(`condition not copied verbatim: "${c.slice(0, 60)}"`);

  const shouldNorm = scope.should.map(norm);
  for (const d of pick?.deferred ?? []) {
    const needle = deferredItem(d);
    if (!shouldNorm.some((s) => s === needle || s.includes(needle) || needle.includes(s)))
      issues.push(`deferred item "${String(d).slice(0, 60)}" is not in the Should table`);
  }

  const content = sectionText(doc, "Content as data");
  for (const f of out.data_files ?? []) if (!content.includes(f.path)) issues.push(`data file "${f.path}" (from the manifest) is not under "## Content as data"`);

  if (out.should_count !== undefined && out.should_count !== scope.should.length)
    issues.push(`should_count ${out.should_count} vs ${scope.should.length} Should rows in the doc`);
  if (out.could_count !== undefined && out.could_count !== scope.could.length)
    issues.push(`could_count ${out.could_count} vs ${scope.could.length} Could rows in the doc`);

  // Nothing the Chair rejected comes back: rejected titles stay out of the design substance.
  // Out of scope is the one place naming them is correct, so it is not scanned.
  const bodyNorm = norm(doc.replace(/^## Out of scope\s*$[\s\S]*$/m, ""));
  for (const r of pick?.rejected ?? []) {
    const title = norm(r.working_title);
    if (title && bodyNorm.includes(title)) issues.push(`rejected pitch "${r.working_title}" appears in the design doc`);
  }
  return issues;
}

/** The design doc as committed: read `<docPath>` from the clone at the reported commit. */
export function docAtCommit(cloneDir: string, commit: string, docPath = "docs/design.md"): { doc?: string; error?: string } {
  try {
    const full = execFileSync("git", ["-C", cloneDir, "rev-parse", `${commit}^{commit}`], { encoding: "utf8" }).trim();
    return { doc: execFileSync("git", ["-C", cloneDir, "show", `${full}:${docPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}
