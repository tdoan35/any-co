// Every capability lane, by static import (no directory scan), so typecheck and bundling see them.
// registry.ts merges their CAPABILITIES and impl.ts their IMPLS at load (merge.ts checks both).
import * as marketing from "./marketing.ts";

export const LANES = { marketing } as const;
