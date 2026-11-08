// QA invariants: pure checks over collected qa/ files (state dumps, events.jsonl, run_summary.json).
// No process I/O so the CLI and tests feed the same data. Numbers in every verdict.
// The schema validator covers exactly the keywords state.schema.json uses and throws on any other,
// so a schema change can't silently weaken the check.
import { readFileSync } from "node:fs";
import path from "node:path";

export const KNOWN_SCHEMA_VERSION = 1;

/** Standard events and their required data keys (docs/contracts/events.md). */
export const STANDARD_EVENTS: Record<string, string[]> = {
  run_start: ["seed"],
  spawn: ["id", "type", "x", "y"],
  hit: ["target", "source", "amount"],
  death: ["target", "cause"],
  levelup: ["level"],
  wave: ["wave"],
  stage: ["stage"],
  pickup: ["item", "count"],
  menu_open: ["menu"],
  run_end: ["outcome"],
  error: ["message"],
};

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RunFiles {
  /** State dumps taken during the run (dump_state after each step chunk) plus the final one, chronological. */
  states: unknown[];
  finalState: unknown;
  events: unknown[];
  runSummary: unknown;
}

export interface InvariantOptions {
  /** Max identical consecutive dumps (tick fields ignored) tolerated while the run is not over. Default 2. */
  identicalDumps?: number;
  /** peaks.entities must be <= this. Default 500. */
  maxEntities?: number;
  /** Simulation ticks per simulated second, for elapsed_s (contract says "e.g. 1/60 s"). Default 60. */
  tickRate?: number;
}

const DEFAULTS: Required<InvariantOptions> = { identicalDumps: 2, maxEntities: 500, tickRate: 60 };

const STATE_SCHEMA_FILE = path.join(import.meta.dirname, "..", "..", "docs", "contracts", "state.schema.json");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const field = (v: unknown, k: string): unknown => (isObj(v) ? v[k] : undefined);
const json = (v: unknown): string => JSON.stringify(v) ?? String(v);

/** A dump with its tick counters removed: a softlocked game keeps ticking but nothing else changes (D5). */
function withoutTicks(s: unknown): string {
  if (!isObj(s)) return json(s);
  const { tick: _tick, run, ...rest } = s;
  const runRest = isObj(run) ? (({ elapsed_ticks: _e, ...r }) => r)(run) : run;
  return json({ ...rest, run: runRest });
}

export function runInvariants(files: RunFiles, opts: InvariantOptions = {}): Check[] {
  const o = { ...DEFAULTS, ...opts };
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const finalState = isObj(files.finalState) ? files.finalState : undefined;
  const summary = isObj(files.runSummary) ? files.runSummary : undefined;
  const events = files.events.filter(isObj);

  // --- schema_version on every payload: dumps, every event, run_summary (README golden rule)
  const badVersions: string[] = [];
  files.states.forEach((s, i) => field(s, "schema_version") !== KNOWN_SCHEMA_VERSION && badVersions.push(`state[${i}]=${json(field(s, "schema_version"))}`));
  files.events.forEach((e, i) => field(e, "schema_version") !== KNOWN_SCHEMA_VERSION && badVersions.push(`event[${i}]=${json(field(e, "schema_version"))}`));
  if (summary === undefined) badVersions.push("run_summary missing");
  else if (summary["schema_version"] !== KNOWN_SCHEMA_VERSION) badVersions.push(`run_summary=${json(summary["schema_version"])}`);
  add(
    "schema_version_known",
    files.states.length > 0 && badVersions.length === 0,
    badVersions.length === 0
      ? `${files.states.length} dump(s), ${files.events.length} event(s), run_summary all schema_version=${KNOWN_SCHEMA_VERSION}`
      : `${badVersions.length} payload(s) not v${KNOWN_SCHEMA_VERSION}: ${badVersions.slice(0, 5).join(", ")}${files.states.length === 0 ? "; no state dumps" : ""}`,
  );

  // --- every dump valid against state.schema.json
  const schema: unknown = JSON.parse(readFileSync(STATE_SCHEMA_FILE, "utf8"));
  const schemaErrors =
    files.states.length === 0
      ? ["no state dump"]
      : files.states.flatMap((s, i) => validateValue(schema, s, `state[${i}]`));
  add("state_matches_schema", schemaErrors.length === 0, schemaErrors.slice(0, 5).join("; ") || `${files.states.length} dump(s) valid`);

  // --- standard events carry their required data keys (events.md)
  const missingKeys: string[] = [];
  events.forEach((e, i) => {
    const name = e["event"];
    if (typeof name !== "string" || !(name in STANDARD_EVENTS)) return;
    const data = e["data"];
    for (const k of STANDARD_EVENTS[name]!) if (!isObj(data) || !(k in data)) missingKeys.push(`event[${i}] ${name}.data.${k}`);
  });
  add("event_data_keys", missingKeys.length === 0, missingKeys.slice(0, 5).join("; ") || "all standard events complete");

  // --- no error events, empty errors[], not crashed
  const errorEvents = events.filter((e) => e["event"] === "error").length;
  const stateErrors = files.states.reduce<number>((n, s) => n + (Array.isArray(field(s, "errors")) ? (field(s, "errors") as unknown[]).length : 0), 0);
  const crashed = files.states.some((s) => field(s, "crashed") === true) || summary?.["crashed"] === true;
  add(
    "no_errors",
    errorEvents === 0 && stateErrors === 0 && !crashed,
    `${errorEvents} error event(s), ${stateErrors} state error(s), crashed=${crashed}`,
  );

  // --- run completes: exactly one run_end with outcome win|loss|quit, matching run_summary, run.over true
  const runEnds = events.filter((e) => e["event"] === "run_end");
  const outcome = runEnds.length === 1 ? field(runEnds[0]!["data"], "outcome") : undefined;
  const summaryOutcome = summary?.["outcome"];
  const runOver = field(finalState?.["run"], "over");
  add(
    "run_completes",
    runEnds.length === 1 && (outcome === "win" || outcome === "loss" || outcome === "quit") && outcome === summaryOutcome && runOver === true,
    `run_end x${runEnds.length} outcome=${json(outcome)}, summary=${json(summaryOutcome)}, run.over=${json(runOver)}`,
  );

  // --- no softlock: while running, ticks strictly increase between dumps, and the state (tick fields ignored)
  //     doesn't repeat more than N times in a row (D5)
  const running = files.states.filter((s) => field(field(s, "run"), "over") !== true);
  const ticks = running.map((s) => num(field(s, "tick")));
  const stalled = ticks.findIndex((t, i) => i > 0 && (t === undefined || ticks[i - 1] === undefined || t <= ticks[i - 1]!));
  let maxIdentical = running.length > 0 ? 1 : 0;
  let streak = 1;
  for (let i = 1; i < running.length; i++) {
    streak = withoutTicks(running[i]) === withoutTicks(running[i - 1]) ? streak + 1 : 1;
    maxIdentical = Math.max(maxIdentical, streak);
  }
  add(
    "no_softlock",
    stalled === -1 && maxIdentical <= o.identicalDumps,
    `${running.length} dump(s) while running; ticks ${stalled === -1 ? "strictly increasing" : `stalled at dump ${stalled} (${json(ticks[stalled - 1])} -> ${json(ticks[stalled])})`}; max identical consecutive (ticks ignored)=${maxIdentical} (limit ${o.identicalDumps})`,
  );

  // --- entity count bounded; resources non-negative
  const peakEntities = num(field(summary?.["peaks"], "entities"));
  add(
    "entities_bounded",
    peakEntities !== undefined && peakEntities <= o.maxEntities,
    `peaks.entities=${json(peakEntities)} limit=${o.maxEntities}`,
  );
  const negative: string[] = [];
  files.states.forEach((s, i) => {
    const res = field(s, "resources");
    if (!isObj(res)) return;
    for (const [k, v] of Object.entries(res)) if (typeof v === "number" && v < 0) negative.push(`state[${i}].${k}=${v}`);
  });
  add("resources_non_negative", negative.length === 0, negative.slice(0, 5).join(", ") || "all >= 0");

  // --- telemetry counts (D8): tally every event name; standard names must match exactly;
  //     non-standard keys in counts are a contract deviation (telemetry.md: counts are standard-event totals)
  const tallies: Record<string, number> = {};
  for (const e of events) if (typeof e["event"] === "string") tallies[e["event"]] = (tallies[e["event"]] ?? 0) + 1;
  const claimed = isObj(summary?.["counts"]) ? (summary!["counts"] as Obj) : {};
  const mismatches = Object.keys(STANDARD_EVENTS)
    .filter((k) => k in claimed || k in tallies)
    .filter((k) => (num(claimed[k]) ?? 0) !== (tallies[k] ?? 0))
    .map((k) => `${k}: summary ${json(claimed[k] ?? 0)} vs events ${tallies[k] ?? 0}`);
  add("telemetry_counts_match", summary !== undefined && mismatches.length === 0, summary === undefined ? "no run_summary" : mismatches.join("; ") || "standard counts match events");
  const nonStandard = Object.keys(claimed).filter((k) => !(k in STANDARD_EVENTS));
  add(
    "telemetry_counts_standard_only",
    nonStandard.length === 0,
    nonStandard.length === 0 ? "counts has only standard events" : `non-standard keys in counts: ${nonStandard.map((k) => `${k}=${json(claimed[k])} (events ${tallies[k] ?? 0})`).join(", ")}`,
  );

  const runTicks = num(summary?.["run_ticks"]);
  const elapsed = num(summary?.["elapsed_s"]);
  const expected = runTicks !== undefined ? runTicks / o.tickRate : undefined;
  add(
    "telemetry_elapsed_matches_ticks",
    expected !== undefined && elapsed !== undefined && Math.abs(expected - elapsed) <= Math.max(1 / o.tickRate, expected * 0.01),
    `run_ticks=${json(runTicks)} / ${o.tickRate} = ${json(expected)} vs elapsed_s=${json(elapsed)}`,
  );

  const finalTick = num(finalState?.["tick"]);
  add(
    "final_tick_matches_summary",
    finalTick !== undefined && runTicks !== undefined && finalTick === runTicks,
    `final state tick=${json(finalTick)} vs run_ticks=${json(runTicks)}`,
  );

  return checks;
}

// --- determinism: diff two final states, report first differing path
export function firstDifference(a: unknown, b: unknown, at = "$"): string | null {
  if (a === b) return null;
  if (isObj(a) && isObj(b)) {
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
  return `${at}: ${json(a)} vs ${json(b)}`;
}

// --- validator for the JSON Schema keywords state.schema.json uses
const SUPPORTED_KEYWORDS: Record<string, true> = {
  $schema: true, $id: true, title: true, description: true,
  type: true, const: true, enum: true, minLength: true, maxLength: true, minimum: true,
  minItems: true, maxItems: true,
  items: true, properties: true, required: true, additionalProperties: true,
};

export function validateValue(schema: unknown, value: unknown, at: string): string[] {
  if (!isObj(schema)) throw new Error(`${at}: schema node is not an object`);
  for (const k of Object.keys(schema)) {
    if (!Object.hasOwn(SUPPORTED_KEYWORDS, k)) throw new Error(`${at}: unsupported schema keyword "${k}" (extend tools/qa/invariants.ts)`);
  }
  if (schema["type"] !== undefined) {
    const types = Array.isArray(schema["type"]) ? (schema["type"] as unknown[]) : [schema["type"]];
    const ok = types.some((t) =>
      t === "object" ? isObj(value)
      : t === "array" ? Array.isArray(value)
      : t === "integer" ? Number.isInteger(value)
      : t === "number" ? typeof value === "number" && Number.isFinite(value)
      : t === "string" ? typeof value === "string"
      : t === "boolean" ? typeof value === "boolean"
      : t === "null" ? value === null
      : false,
    );
    if (!ok) return [`${at}: expected type ${types.join("|")}, got ${json(value)}`];
  }
  if ("const" in schema && value !== schema["const"]) return [`${at}: expected const ${json(schema["const"])}, got ${json(value)}`];
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return [`${at}: not in enum ${json(schema["enum"])}`];

  const errors: string[] = [];
  if (typeof value === "string") {
    const min = num(schema["minLength"]);
    const max = num(schema["maxLength"]);
    if (min !== undefined && value.length < min) errors.push(`${at}: shorter than minLength ${min}`);
    if (max !== undefined && value.length > max) errors.push(`${at}: longer than maxLength ${max}`);
  }
  if (typeof value === "number") {
    const min = num(schema["minimum"]);
    if (min !== undefined && value < min) errors.push(`${at}: ${value} below minimum ${min}`);
  }
  if (Array.isArray(value)) {
    const minItems = num(schema["minItems"]);
    const maxItems = num(schema["maxItems"]);
    if (minItems !== undefined && value.length < minItems) errors.push(`${at}: fewer than minItems ${minItems}`);
    if (maxItems !== undefined && value.length > maxItems) errors.push(`${at}: more than maxItems ${maxItems}`);
    if (schema["items"] !== undefined) {
      value.forEach((item, i) => errors.push(...validateValue(schema["items"], item, `${at}[${i}]`)));
    }
  }
  // Object keywords apply to every object value, with or without `properties` (D6: `resources` has none).
  if (isObj(value)) {
    const props = isObj(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    for (const req of required) if (typeof req === "string" && !(req in value)) errors.push(`${at}: missing "${req}"`);
    for (const [k, sub] of Object.entries(props)) if (k in value) errors.push(...validateValue(sub, value[k], `${at}.${k}`));
    const additional = schema["additionalProperties"];
    for (const [k, v] of Object.entries(value)) {
      if (k in props) continue;
      if (additional === false) errors.push(`${at}: additional property "${k}"`);
      else if (isObj(additional)) errors.push(...validateValue(additional, v, `${at}.${k}`));
    }
  }
  return errors;
}
