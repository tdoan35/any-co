// QA invariants: pure checks over collected qa/ files (state.json, events.jsonl, run_summary.json).
// No I/O here so the CLI and tests feed the same data. Numbers in every verdict.
// The schema validator covers exactly the features state.schema.json uses (no $ref/allOf etc.):
// type, const, required, properties, additionalProperties, items, minLength, maxLength, minimum.
import { readFileSync } from "node:fs";
import path from "node:path";

export const KNOWN_SCHEMA_VERSION = 1;

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RunFiles {
  /** Successive qa/state.json dumps, chronological. */
  states: unknown[];
  finalState: unknown;
  events: unknown[];
  runSummary: unknown;
}

export interface InvariantOptions {
  /** Max identical consecutive dumps tolerated while the run is not over (softlock check). Default 2. */
  identicalDumps?: number;
  /** peaks.entities must be <= this. Default 500. */
  maxEntities?: number;
}

const DEFAULTS: Required<InvariantOptions> = { identicalDumps: 2, maxEntities: 500 };

// Minimal typed views over untrusted JSON. Guard once, use fields with confidence.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

function schemaVersion(s: unknown): unknown {
  return isObj(s) ? s["schema_version"] : undefined;
}
function eventFields(e: unknown): { event: unknown; data: unknown } {
  if (!isObj(e)) return { event: undefined, data: undefined };
  return { event: e["event"], data: isObj(e["data"]) ? e["data"] : undefined };
}
function stateErrors(s: unknown): unknown[] {
  if (!isObj(s)) return [];
  return arr(s["errors"]) ?? [];
}
function stateResources(s: unknown): Record<string, unknown> {
  if (!isObj(s) || !isObj(s["resources"])) return {};
  return s["resources"];
}
function stateRun(s: unknown): Record<string, unknown> | undefined {
  return isObj(s) && isObj(s["run"]) ? s["run"] : undefined;
}
function counts(summary: unknown): Record<string, unknown> {
  return isObj(summary) && isObj(summary["counts"]) ? summary["counts"] : {};
}
function peaksEntities(summary: unknown): number | undefined {
  return isObj(summary) && isObj(summary["peaks"]) ? num(summary["peaks"]["entities"]) : undefined;
}

export function runInvariants(files: RunFiles, opts: InvariantOptions = {}): Check[] {
  const o = { ...DEFAULTS, ...opts };
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const finalState = isObj(files.finalState) ? files.finalState : undefined;
  const summary = isObj(files.runSummary) ? files.runSummary : undefined;

  // --- schema_version present and understood
  const versions = files.states.map(schemaVersion);
  add(
    "schema_version_known",
    versions.length > 0 && versions.every((v) => v === KNOWN_SCHEMA_VERSION),
    `state dumps schema_version=${JSON.stringify(versions)}, known=${KNOWN_SCHEMA_VERSION}`,
  );

  // --- final state valid against state.schema.json
  const schema = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "contracts", "state.schema.json"), "utf8"),
  ) as unknown;
  const schemaErrors = files.finalState !== undefined ? validateValue(schema, files.finalState, "$") : ["no final state dump"];
  add("state_matches_schema", schemaErrors.length === 0, schemaErrors.slice(0, 5).join("; ") || "valid");

  // --- no error events, empty errors[], not crashed
  const errorEvents = files.events.filter((e) => eventFields(e).event === "error");
  const allStateErrors = files.states.flatMap(stateErrors);
  const crashed =
    files.states.some((s) => isObj(s) && s["crashed"] === true) || (summary !== undefined && summary["crashed"] === true);
  add(
    "no_errors",
    errorEvents.length === 0 && allStateErrors.length === 0 && !crashed,
    `${errorEvents.length} error event(s), ${allStateErrors.length} state error(s), crashed=${crashed}`,
  );

  // --- run completes: run_end with outcome win|loss|quit, matching run_summary, run.over true
  const runEnds = files.events.filter((e) => eventFields(e).event === "run_end");
  const runEndData = runEnds.map((e) => eventFields(e).data);
  const validOutcome = (v: unknown): v is "win" | "loss" | "quit" => v === "win" || v === "loss" || v === "quit";
  const outcome = runEndData.length === 1 ? (runEndData[0] as Record<string, unknown> | undefined)?.["outcome"] : undefined;
  const summaryOutcome = summary?.["outcome"];
  const runOver = stateRun(finalState)?.["over"];
  add(
    "run_completes",
    runEnds.length === 1 && validOutcome(outcome) && outcome === summaryOutcome && runOver === true,
    `run_end x${runEnds.length} outcome=${JSON.stringify(outcome)}, summary=${JSON.stringify(summaryOutcome)}, run.over=${JSON.stringify(runOver)}`,
  );

  // --- no softlock: ticks monotonic; <= N identical consecutive dumps while run not over
  const ticks = files.states.map((s) => num(isObj(s) ? s["tick"] : undefined));
  const ticksAdvance = ticks.every((t, i) => i === 0 || t === undefined || ticks[i - 1] === undefined || t >= ticks[i - 1]!);
  let maxIdentical = 1;
  let run = 1;
  for (let i = 1; i < files.states.length; i++) {
    const same = JSON.stringify(files.states[i]) === JSON.stringify(files.states[i - 1]);
    run = same ? run + 1 : 1;
    maxIdentical = Math.max(maxIdentical, run);
  }
  const notOverDumps = files.states.filter((s) => stateRun(s)?.["over"] !== true).length;
  const softlocked = notOverDumps > 1 && maxIdentical > o.identicalDumps;
  add(
    "no_softlock",
    ticksAdvance && !softlocked,
    `ticks monotonic=${ticksAdvance}, max identical consecutive dumps=${maxIdentical} (limit ${o.identicalDumps}), ${notOverDumps} dump(s) with run not over`,
  );

  // --- entity count bounded; resources non-negative
  const peakEntities = peaksEntities(summary);
  const negative: string[] = [];
  for (const s of files.states) {
    for (const [k, v] of Object.entries(stateResources(s))) {
      const n = num(v);
      if (n !== undefined && n < 0) negative.push(`${k}=${n}`);
    }
  }
  add(
    "entities_bounded",
    peakEntities !== undefined && peakEntities <= o.maxEntities,
    `peaks.entities=${JSON.stringify(peakEntities)} limit=${o.maxEntities}`,
  );
  add("resources_non_negative", negative.length === 0, negative.slice(0, 5).join(",") || "all >= 0");

  // --- telemetry: counts equal standard-event tallies; elapsed_s consistent with run_ticks
  const standard = ["run_start", "spawn", "hit", "death", "levelup", "wave", "stage", "pickup", "menu_open", "run_end", "error"];
  const tallies: Record<string, number> = {};
  for (const e of files.events) {
    const name = str(eventFields(e).event);
    if (name !== undefined && standard.includes(name)) tallies[name] = (tallies[name] ?? 0) + 1;
  }
  const claimed = counts(summary);
  const mismatches = Object.keys({ ...claimed, ...tallies }).filter(
    (k) => (num(claimed[k]) ?? 0) !== (num(tallies[k]) ?? 0),
  );
  add(
    "telemetry_counts_match",
    mismatches.length === 0,
    mismatches.map((k) => `${k}: summary ${String(claimed[k])} vs events ${tallies[k] ?? 0}`).join("; ") || "all match",
  );

  const tickRate = 60; // sim ticks per simulated second; time-scale changes wall speed only (controls.md)
  const runTicks = num(summary?.["run_ticks"]);
  const elapsed = num(summary?.["elapsed_s"]);
  const elapsedOk =
    runTicks !== undefined && elapsed !== undefined
      ? Math.abs(runTicks / tickRate - elapsed) <= Math.max(1, (runTicks / tickRate) * 0.01)
      : false;
  add(
    "telemetry_elapsed_matches_ticks",
    elapsedOk,
    `run_ticks=${JSON.stringify(runTicks)} / ${tickRate} vs elapsed_s=${JSON.stringify(elapsed)}`,
  );

  const finalTick = num(finalState?.["tick"]);
  const tickAgrees = finalTick === undefined || runTicks === undefined ? true : finalTick === runTicks;
  add(
    "final_tick_matches_summary",
    tickAgrees,
    `final state tick=${JSON.stringify(finalTick)} vs run_ticks=${JSON.stringify(runTicks)}`,
  );

  return checks;
}

// --- determinism: diff two final states, report first differing path
export function firstDifference(a: unknown, b: unknown, at = "$"): string | null {
  if (a === b) return null;
  const aObj = isObj(a);
  const bObj = isObj(b);
  if (aObj && bObj) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at} (length ${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  return `${at}: ${safeJson(a)} vs ${safeJson(b)}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// --- minimal validator for the schema features state.schema.json uses
interface SchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
}

function isSchema(v: unknown): v is SchemaNode {
  return isObj(v);
}

export function validateValue(schema: unknown, value: unknown, at: string): string[] {
  if (!isSchema(schema)) return [`${at}: invalid schema node`];
  const errors: string[] = [];
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = ts.some((t) =>
      t === "object" ? isObj(value)
      : t === "array" ? Array.isArray(value)
      : t === "integer" ? Number.isInteger(value)
      : t === "number" ? typeof value === "number" && !Number.isNaN(value)
      : t === "string" ? typeof value === "string"
      : t === "boolean" ? typeof value === "boolean"
      : t === "null" ? value === null
      : false,
    );
    if (!ok) return [`${at}: expected type ${ts.join("|")}`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: expected const ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: not in enum ${JSON.stringify(schema.enum)}`];
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than maxLength ${schema.maxLength}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: below minimum ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateValue(schema.items, item, `${at}[${i}]`)));
  }
  if (isObj(value) && schema.properties) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${at}: missing "${req}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) errors.push(...validateValue(sub, value[k], `${at}.${k}`));
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errors.push(`${at}: additional property "${k}"`);
      }
    } else if (isSchema(additional)) {
      for (const [k, v] of Object.entries(value)) {
        if (!(k in schema.properties)) errors.push(...validateValue(additional, v, `${at}.${k}`));
      }
    }
  }
  return errors;
}
