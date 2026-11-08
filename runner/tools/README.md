# runner/tools — capabilities

`registry.ts` names the core capabilities (what a spec can grant); `impl.ts` implements them locally;
`kit.ts` holds the shared tool types and helpers. Teams add capabilities in **lanes**
(`lanes/<lane>.ts`) without editing the shared files.

## Add a lane capability (5 steps)
1. In `lanes/<lane>.ts` add an entry to `CAPABILITIES` (`summary`, `naive`, `local`, `note?`), with `outward` always set: `true` if it sends or spends outside the studio, `false` otherwise (a lane capability without it fails at load).
2. Add its tools under the same key in `IMPLS` (`{ <tool_name>: { description, input: zod, run(input, ctx) } }`); import helpers from `../kit.ts`, never `../impl.ts` or `../registry.ts`.
3. New lane file? Add one static import line to `lanes/index.ts`.
4. Grant it per agent in that agent's `spec.ts` `tools` (an outward capability only as `"ask"`), then `npm run agents -- validate`.
5. Ship a test for each tool, and run `npm test` (lane load checks run there too).

## What load enforces (lanes/merge.ts, runner/spec.ts)
- A lane can't redefine a core capability or another lane's, and its tools can't reuse any existing tool name (`submit_result` included). Each violation throws at load.
- No default grants: a capability reaches an agent only through its spec's `tools`.
- `outward: true` capabilities granted `"allow"` fail spec validation. Every call goes through the approval gate and the ledger. The core sends (`itch_push`, `email_send`, `site_deploy`) are outward too.

Lanes: `marketing` (Joyce: Marketing & Distribution).
