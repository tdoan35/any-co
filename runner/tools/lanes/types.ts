// Shapes a capability lane module exports (see runner/tools/README.md). Type-only: no runtime imports.
import type { Capability } from "../registry.ts";
import type { ToolImpl } from "../kit.ts";

export type LaneCapabilities = Record<string, Capability>;
/** Every capability a lane declares as `local: true` has its model-facing tools here, keyed by capability. */
export type LaneImpls<C extends LaneCapabilities> = { [K in keyof C]: Record<string, ToolImpl> };
export interface LaneModule {
  CAPABILITIES: LaneCapabilities;
  IMPLS: Record<string, Record<string, ToolImpl>>;
}
