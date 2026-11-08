// Load-time merge of capability lanes into the core registry and implementations. Mechanical and
// loud: anything that could let a lane change what an existing capability or tool does throws at
// load, so a bad lane fails `npm test`, `agents validate`, and every run before any agent starts.
import type { Capability } from "../registry.ts";
import type { ToolImpl } from "../kit.ts";
import type { LaneModule } from "./types.ts";

/** Tool names the runner itself owns. */
export const RESERVED_TOOLS = ["submit_result"];
const NAME = /^[a-z][a-z0-9_]{1,47}$/;

export function mergeCapabilities<C extends Record<string, Capability>>(core: C, lanes: Record<string, LaneModule>): Record<string, Capability> {
  const out: Record<string, Capability> = { ...core };
  const owner = new Map<string, string>();
  for (const [lane, mod] of Object.entries(lanes)) {
    for (const [name, cap] of Object.entries(mod.CAPABILITIES)) {
      if (!NAME.test(name)) throw new Error(`lane "${lane}": capability name "${name}" must be snake_case (${NAME})`);
      if (name in core) throw new Error(`lane "${lane}" redefines core capability "${name}"`);
      if (owner.has(name)) throw new Error(`lane "${lane}" redefines capability "${name}" from lane "${owner.get(name)}"`);
      if (typeof cap?.summary !== "string" || !Array.isArray(cap.naive) || typeof cap.local !== "boolean")
        throw new Error(`lane "${lane}": capability "${name}" needs summary, naive[], local`);
      owner.set(name, lane);
      out[name] = cap;
    }
  }
  return out;
}

export function mergeImpls(core: Record<string, Record<string, ToolImpl>>, lanes: Record<string, LaneModule>): Record<string, Record<string, ToolImpl>> {
  const out: Record<string, Record<string, ToolImpl>> = { ...core };
  const toolOwner = new Map<string, string>();
  for (const [cap, tools] of Object.entries(core)) for (const t of Object.keys(tools)) toolOwner.set(t, `core capability "${cap}"`);
  for (const t of RESERVED_TOOLS) toolOwner.set(t, "the runner");
  for (const [lane, mod] of Object.entries(lanes)) {
    for (const [cap, tools] of Object.entries(mod.IMPLS)) {
      if (!(cap in mod.CAPABILITIES)) throw new Error(`lane "${lane}" implements capability "${cap}" that it does not declare in its CAPABILITIES`);
      if (cap in core) throw new Error(`lane "${lane}" redefines core capability "${cap}"`);
      for (const [tool, impl] of Object.entries(tools)) {
        if (!NAME.test(tool)) throw new Error(`lane "${lane}": tool name "${tool}" must be snake_case (${NAME})`);
        if (toolOwner.has(tool)) throw new Error(`lane "${lane}" tool "${tool}" shadows the tool of ${toolOwner.get(tool)}`);
        if (typeof impl?.run !== "function" || typeof impl.description !== "string") throw new Error(`lane "${lane}": tool "${tool}" needs description and run()`);
        toolOwner.set(tool, `lane "${lane}" capability "${cap}"`);
      }
      out[cap] = tools;
    }
    for (const [cap, def] of Object.entries(mod.CAPABILITIES))
      if (def.local && !(cap in mod.IMPLS)) throw new Error(`lane "${lane}" declares capability "${cap}" as local but has no IMPLS for it`);
  }
  return out;
}
