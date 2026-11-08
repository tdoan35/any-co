// Agent spec: the source of truth for one studio agent (CLAUDE.md, rule 1).
// One folder per agent: agents/<name>/spec.ts (default export defineAgent({...})) + system.md.
// Both runners read the same spec: the local runner directly, the Naïve runner via toNaiveAgent().
import { z } from "zod";
import { CAPABILITIES, type Capability, type CapabilityName } from "./tools/registry.ts";

export const Permission = z.enum(["allow", "ask", "deny"]);
export type Permission = z.infer<typeof Permission>;

const usd = z.number().positive().max(1000);

export const Budget = z
  .object({
    cap_usd: usd, // total per period
    max_task_usd: usd, // one session / one local run
    period: z.enum(["day", "week", "month"]),
  })
  .strict()
  .refine((b) => b.max_task_usd <= b.cap_usd, { message: "max_task_usd must be <= cap_usd" });

// Where inference comes from. Naïve proxy by default; local agents may use an external
// OpenAI-compatible provider (e.g. superfast inference for Eng). External calls bypass Naïve's
// budget checks, so a price is required for local spend tracking.
export const Provider = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("naive") }).strict(),
  z
    .object({
      kind: z.literal("openai_compatible"),
      model: z.string().min(1), // provider's own model id
      base_url_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      usd_per_mtok: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).strict(),
    })
    .strict(),
]);

/**
 * Tool grants against a capability table (core + lanes): every name must exist, and a capability
 * marked `outward` (sends or spends outside the studio) may only be granted "ask" or "deny".
 * Returns one issue per bad grant. Grants are explicit per agent: nothing is granted by default.
 */
export function grantIssues(rec: Record<string, string>, caps: Record<string, Capability> = CAPABILITIES): Array<{ path: string; message: string }> {
  const known = Object.keys(caps);
  const issues: Array<{ path: string; message: string }> = [];
  for (const [k, perm] of Object.entries(rec)) {
    if (!(k in caps)) issues.push({ path: k, message: `unknown capability "${k}"; known: ${known.join(", ")}` });
    else if (caps[k].outward && perm === "allow")
      issues.push({ path: k, message: `capability "${k}" sends or spends outside the studio: grant it "ask" (approval gate + ledger), never "allow"` });
  }
  return issues;
}

const tools = z
  .record(z.string(), Permission)
  .superRefine((rec, ctx) => {
    for (const i of grantIssues(rec)) ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
  })
  .transform((rec) => rec as Partial<Record<CapabilityName, Permission>>);

export const AgentSpecInput = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "kebab-case, 2-41 chars"),
    description: z.string().min(10).max(300),
    dept: z.enum(["head", "greenlight", "design", "art", "audio", "eng", "qa", "marketing", "ops", "test"]),
    runner: z.enum(["local", "naive"]),
    model: z.string().min(1), // Naïve catalogue id (used for the Naïve runner and the naive provider)
    provider: Provider.default({ kind: "naive" }),
    harness: z.enum(["pi", "vetta"]).default("pi"), // only runnable hosted harnesses
    window: z.enum(["immediate", "priority", "loose"]).default("immediate"),
    budget: Budget,
    // Capabilities by permission. Each maps to a local implementation and to Naïve built-in tools.
    tools: tools.default({}),
    skills: z.array(z.string()).default([]), // Naïve skill slugs
    output_schema: z.custom<z.ZodType>((v) => v instanceof z.ZodType, "must be a zod schema").optional(),
    // Deterministic code run on a validated result before it's saved (e.g. adding computed numbers),
    // so agents submit judgments and code supplies the mechanical parts (CLAUDE.md, rule 5).
    postprocess: z.custom<(output: any) => Promise<any>>((v) => typeof v === "function", "must be an async function").optional(),
    limits: z
      .object({
        max_turns: z.number().int().positive().max(200).default(30),
        max_output_tokens: z.number().int().positive().max(32768).default(8192),
      })
      .strict()
      .default({ max_turns: 30, max_output_tokens: 8192 }),
  })
  .strict();

export type AgentSpecInput = z.input<typeof AgentSpecInput>;
export type AgentSpec = z.output<typeof AgentSpecInput> & { system: string; dir: string };

/**
 * Required in the output of every agent that does ticket work (T29). The dispatcher closes the card as done
 * only when this is true; false blocks the card with the agent's own summary, so "ran to the end" is never
 * mistaken for "the work is done". One shared field, so the description is identical in every spec.
 */
export const COMPLETE_DESCRIPTION =
  "true only if the ticket's done criteria are met and the work is committed and pushed; false if anything is left (out of budget or turns, blocked, partial, uncommitted)";
export const COMPLETE = z.boolean().describe(COMPLETE_DESCRIPTION);

/** Identity helper so spec files get type checking. Validation happens in the loader. */
export function defineAgent(spec: AgentSpecInput): AgentSpecInput {
  return spec;
}

export const microUsd = (usdAmount: number) => Math.round(usdAmount * 1_000_000);
