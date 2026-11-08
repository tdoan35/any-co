// A JSON-schema "pattern" that isn't anchored at the start made GLM-5.3 (via the Naïve proxy) emit art_generate out ".png"
// in about half its calls (Nov 8 probe: 3/6 with `\.png$`, 0/6 without). Tool schemas must not carry unanchored patterns;
// a suffix/shape check belongs in the tool's run-time validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { IMPLS } from "./impl.ts";
import { modelSafeSchema } from "../run.ts";

function patterns(node: unknown, at: string, out: string[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => patterns(n, `${at}[${i}]`, out));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "pattern" && typeof v === "string" && !v.startsWith("^")) out.push(`${at}: ${v}`);
    else patterns(v, `${at}.${k}`, out);
  }
}

test("no tool input schema sent to a model has an unanchored pattern (GLM truncates the value to the suffix)", () => {
  const bad: string[] = [];
  for (const [cap, tools] of Object.entries(IMPLS))
    for (const [name, impl] of Object.entries(tools as Record<string, { input: z.ZodType }>)) {
      const raw = z.toJSONSchema(impl.input, { io: "input", unrepresentable: "any" });
      patterns(modelSafeSchema(raw), `${cap}.${name}`, bad);
    }
  assert.deepEqual(bad, []);
});
