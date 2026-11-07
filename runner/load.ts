// Load, validate, and translate agent specs from agents/<name>/.
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { AgentCreate } from "@usenaive-sdk/managed-agents";
import { AgentSpecInput, microUsd, type AgentSpec, type Permission } from "./spec.ts";
import { CAPABILITIES, type CapabilityName } from "./tools/registry.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENTS_DIR = path.join(ROOT, "agents");

export class SpecError extends Error {
  constructor(public agent: string, public issues: string[]) {
    super(`agents/${agent}: ${issues.join("; ")}`);
  }
}

export async function listAgentNames(dir = AGENTS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (await exists(path.join(dir, e.name, "spec.ts"))) names.push(e.name);
  }
  return names.sort();
}

export async function loadAgent(name: string, dir = AGENTS_DIR): Promise<AgentSpec> {
  const agentDir = path.join(dir, name);
  const specPath = path.join(agentDir, "spec.ts");
  const systemPath = path.join(agentDir, "system.md");
  if (!(await exists(specPath))) throw new SpecError(name, ["missing spec.ts"]);
  if (!(await exists(systemPath))) throw new SpecError(name, ["missing system.md"]);

  const mod = await import(pathToFileURL(specPath).href);
  const parsed = AgentSpecInput.safeParse(mod.default);
  if (!parsed.success) {
    throw new SpecError(name, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const spec = parsed.data;
  const issues: string[] = [];
  if (spec.name !== name) issues.push(`name "${spec.name}" must match folder "${name}"`);
  const system = (await readFile(systemPath, "utf8")).trim();
  if (system.length < 50) issues.push("system.md is too short (< 50 chars)");
  if (spec.output_schema && !(spec.output_schema instanceof z.ZodObject)) {
    issues.push("output_schema must be a z.object(...) (it becomes the submit_result tool's input)");
  }
  if (spec.provider.kind !== "naive" && spec.runner === "naive") {
    issues.push("runner: naive requires provider: naive (hosted agents use Naïve inference)");
  }
  if (issues.length) throw new SpecError(name, issues);
  return { ...spec, system, dir: agentDir };
}

export async function loadAllAgents(dir = AGENTS_DIR) {
  const ok: AgentSpec[] = [];
  const errors: SpecError[] = [];
  for (const n of await listAgentNames(dir)) {
    try {
      ok.push(await loadAgent(n, dir));
    } catch (e) {
      errors.push(e instanceof SpecError ? e : new SpecError(n, [String(e)]));
    }
  }
  return { ok, errors };
}

/** JSON Schema for the agent's final output, if it declares one. */
export function outputJsonSchema(spec: AgentSpec): Record<string, unknown> | null {
  return spec.output_schema ? (z.toJSONSchema(spec.output_schema) as Record<string, unknown>) : null;
}

/** Stable hash of everything that defines the agent's behavior; stored in Naïve metadata. */
export function specHash(spec: AgentSpec): string {
  const { dir: _dir, output_schema: _schema, ...rest } = spec;
  const body = JSON.stringify({ ...rest, output_schema: outputJsonSchema(spec) });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** The Naïve `agents.create` body for this spec. Every Naïve tool not granted is denied. */
export function toNaiveAgent(spec: AgentSpec): AgentCreate {
  const configs: Record<string, { enabled: boolean; permission: Permission }> = {};
  const rank: Record<Permission, number> = { deny: 0, ask: 1, allow: 2 };
  for (const [cap, perm] of Object.entries(spec.tools) as [CapabilityName, Permission][]) {
    for (const tool of CAPABILITIES[cap].naive) {
      const prev = configs[tool]?.permission ?? "deny";
      // A Naïve tool shared by two capabilities gets the stricter permission (deny < ask < allow).
      const permission = configs[tool] && rank[prev] < rank[perm] ? prev : perm;
      configs[tool] = { enabled: permission !== "deny", permission };
    }
  }
  const schema = outputJsonSchema(spec);
  return {
    name: spec.name,
    description: spec.description,
    model: spec.model,
    harness: spec.harness,
    window: spec.window,
    system: spec.system,
    skills: spec.skills,
    budget: {
      cap_micro_usd: microUsd(spec.budget.cap_usd),
      max_task_micro_usd: microUsd(spec.budget.max_task_usd),
      period: spec.budget.period,
    },
    tools: { default_config: { permission: "deny" }, configs },
    output_schema: schema,
    structured_output_required: schema !== null,
    metadata: { studio: "any-co", dept: spec.dept, spec_hash: specHash(spec) },
  } as AgentCreate;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
