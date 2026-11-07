# Agent specs

One folder per agent: `agents/<name>/spec.ts` + `agents/<name>/system.md`. The spec is the
source of truth for both runners. Schema: `runner/spec.ts`; loader and Naïve translation: `runner/load.ts`.

```ts
import { z } from "zod";
import { defineAgent } from "../../runner/spec.ts";

export default defineAgent({
  name: "my-agent",                 // must match the folder
  description: "One line on what it does.",
  dept: "greenlight",               // head | greenlight | design | art | audio | eng | qa | marketing | ops | test
  runner: "local",                  // local | naive
  model: "z-ai/glm-5.3",            // Naïve catalogue id
  provider: { kind: "naive" },      // default. Local-only alternative: { kind: "openai_compatible", model,
                                    //   base_url_env, api_key_env, usd_per_mtok: { input, output } }
  budget: { cap_usd: 2, max_task_usd: 0.5, period: "day" },   // required
  tools: { catalog_query: "allow", web_fetch: "ask" },        // capabilities: allow | ask | deny
  output_schema: z.object({ ... }), // optional; final answer is validated against it
  limits: { max_turns: 30, max_output_tokens: 8192 },          // local runner limits (defaults shown)
});
```

- **Capabilities, not tool names.** `runner/tools/registry.ts` maps each capability to a local
  implementation and to the Naïve built-in tools (e.g. `workspace_write` → `write`, `edit`).
  On Naïve, every tool not granted is denied.
- **`ask`** means the approval gate: the local runner pauses for a human; Naïve uses its own approvals.
- **Budgets are in USD** here and converted to integer micro-USD for Naïve.
- **External providers are local-only.** Their spend is tracked only by our runner, so the price is required.
- `toy-*` agents exist to test the runner and make no game content.

Commands: `npm run agents -- list | show <name> | validate [--remote]`, `npm test`.
