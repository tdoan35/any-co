// Media CLI for humans (JSON on stdout): npm run media -- probe <file> | edit <plan.json>
// Paths in the plan resolve against the current directory. Agents use the media_capture capability,
// which confines inputs to their workspace and outputs to media/; capture runs only through it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { edit, probe } from "./edit.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const usage = "usage: media.ts probe <file> | edit <plan.json>";
  try {
    if (cmd === "probe" && arg) console.log(JSON.stringify(await probe(arg)));
    else if (cmd === "edit" && arg) {
      const r = await edit(JSON.parse(readFileSync(arg, "utf8")), { resolveInput: (p) => path.resolve(p), resolveOutput: (p) => path.resolve(p) });
      console.log(JSON.stringify(r));
    } else {
      console.error(usage);
      process.exitCode = 2;
    }
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    process.exitCode = 1;
  }
}
