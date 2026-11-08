// T33: images reach an OpenAI-compatible model on the wire (the T8 path: a tool's image rides the user
// message right after the tool messages), and OpenAI's max_completion_tokens 400 is handled. Fake server only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { OpenAICompatibleProvider, providerFor } from "./providers.ts";
import { runAgent } from "./run.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "__fixtures__", "agents");
const PNG = readFileSync(path.join(HERE, "__fixtures__", "img", "tiny.png"));

interface Seen { body: any }

/** Fake /chat/completions: answers each request with the next scripted reply (OpenAI shape); records the parsed bodies. */
async function fakeOpenAI(replies: Array<(body: any) => { status: number; json: unknown }>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ body });
      const next = replies.shift();
      const out = next ? next(body) : { status: 500, json: { error: "no more replies" } };
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.json));
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const toolCall = (name: string, args: unknown, id: string) => ({
  status: 200,
  json: { id: `c-${id}`, model: "vision-m", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
});

test("T33: an image_view result reaches the OpenAI-compatible model as an image_url in the user message after the tool message", async () => {
  const api = await fakeOpenAI([
    // OpenAI's real refusal for max_tokens on current models: switched once, then never sent again
    () => ({ status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } } }),
    () => toolCall("art_view", { path: "frame.png" }, "v1"),
    () => toolCall("submit_result", { answer: "red pixel" }, "s1"),
  ]);
  try {
    const spec = await loadAgent("image-agent", FIX);
    const runsDir = mkdtempSync(path.join(tmpdir(), "t33-"));
    const provider = new OpenAICompatibleProvider(api.base, "k", "vision-m", { input: 0.75, output: 4.5 });
    const warn = console.warn;
    console.warn = () => {};
    let r;
    try {
      mkdirSync(path.join(runsDir, "v", "workspace"), { recursive: true });
      writeFileSync(path.join(runsDir, "v", "workspace", "frame.png"), PNG);
      r = await runAgent(spec, { task: "Look at frame.png", provider, naive: null, runsDir, runId: "v" });
    } finally {
      console.warn = warn;
    }
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.deepEqual(r.output, { answer: "red pixel" });

    assert.equal(api.seen.length, 3);
    assert.ok("max_tokens" in api.seen[0].body && !("max_completion_tokens" in api.seen[0].body));
    for (const s of api.seen.slice(1)) assert.ok("max_completion_tokens" in s.body && !("max_tokens" in s.body), "switched for good");

    const msgs = api.seen[2].body.messages as any[];
    const toolIdx = msgs.findIndex((m) => m.role === "tool" && m.tool_call_id === "v1");
    assert.ok(toolIdx > 0, JSON.stringify(msgs).slice(0, 500));
    assert.equal(typeof msgs[toolIdx].content, "string", "tool messages carry text only");
    const next = msgs[toolIdx + 1];
    assert.equal(next.role, "user");
    assert.deepEqual(next.content[0], { type: "text", text: "image from tool_call v1" });
    assert.equal(next.content[1].type, "image_url");
    assert.equal(next.content[1].image_url.url, `data:image/png;base64,${PNG.toString("base64")}`, "the exact PNG bytes arrive");
  } finally {
    await api.close();
  }
});

test("T33: base_url_default applies when the base-URL env is unset or empty; the key is still required", async () => {
  const spec = await loadAgent("ui-ux-designer");
  assert.equal(spec.provider.kind, "openai_compatible");
  const p = spec.provider as Extract<typeof spec.provider, { kind: "openai_compatible" }>;
  const prev = { base: process.env[p.base_url_env], key: process.env[p.api_key_env] };
  try {
    process.env[p.base_url_env] = "";
    process.env[p.api_key_env] = "sk-test";
    const prov = providerFor(spec, null) as any;
    assert.equal(prov.baseUrl, "https://api.openai.com/v1");
    process.env[p.base_url_env] = "http://gateway.local/v1";
    assert.equal((providerFor(spec, null) as any).baseUrl, "http://gateway.local/v1");
    delete process.env[p.api_key_env];
    assert.throws(() => providerFor(spec, null), new RegExp(`set ${p.api_key_env}`));
  } finally {
    for (const [k, v] of [[p.base_url_env, prev.base], [p.api_key_env, prev.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- T33b: OpenAI Responses API (gpt-6.1-*: "Tool calling requires the Responses API") ----

const fnCall = (name: string, args: unknown, id: string) => ({
  status: 200,
  json: { id: `resp-${id}`, model: "gpt-6.1-terra", status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "function_call", id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 20 } },
});

test("T33b: Responses API mode: tools, function_call / function_call_output items, and the tool's image as input_image after the output", async () => {
  const api = await fakeOpenAI([() => fnCall("art_view", { path: "frame.png" }, "v1"), () => fnCall("submit_result", { answer: "red pixel" }, "s1")]);
  try {
    const spec = await loadAgent("image-agent", FIX);
    const runsDir = mkdtempSync(path.join(tmpdir(), "t33b-"));
    mkdirSync(path.join(runsDir, "r", "workspace"), { recursive: true });
    writeFileSync(path.join(runsDir, "r", "workspace", "frame.png"), PNG);
    const provider = new OpenAICompatibleProvider(api.base, "k", "gpt-6.1-terra", { input: 1, output: 5 }, "responses");
    const r = await runAgent(spec, { task: "Look at frame.png", provider, naive: null, runsDir, runId: "r" });
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.deepEqual(r.output, { answer: "red pixel" });
    assert.equal(api.seen.length, 2);

    const first = api.seen[0].body;
    assert.equal(first.model, "gpt-6.1-terra");
    assert.equal(typeof first.instructions, "string");
    assert.equal(first.store, false);
    assert.equal(first.max_output_tokens, spec.limits.max_output_tokens);
    assert.ok(!("max_tokens" in first) && !("messages" in first));
    const viewTool = first.tools.find((t: any) => t.name === "art_view");
    assert.deepEqual([viewTool.type, viewTool.strict, typeof viewTool.parameters], ["function", false, "object"]);

    const input = api.seen[1].body.input as any[];
    const call = input.findIndex((i) => i.type === "function_call" && i.call_id === "v1");
    assert.ok(call >= 0, JSON.stringify(input).slice(0, 600));
    assert.equal(input[call].name, "art_view");
    assert.equal(input[call].id, undefined, "no stored-item id: the call is fresh input");
    const outIdx = input.findIndex((i) => i.type === "function_call_output" && i.call_id === "v1");
    assert.equal(outIdx, call + 1);
    assert.match(input[outIdx].output, /\[image follows\]$/);
    const img = input[outIdx + 1];
    assert.equal(img.role, "user");
    assert.deepEqual(img.content[0], { type: "input_text", text: "image from tool_call v1" });
    assert.deepEqual(img.content[1], { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` });
    assert.equal(r.spent_micro_usd ?? 0, 2 * Math.ceil(100 * 1 + 20 * 5));
  } finally {
    await api.close();
  }
});

test("T33b: Responses text replies, an output-token cutoff, and the designer spec's provider", async () => {
  const api = await fakeOpenAI([
    () => ({ status: 200, json: { id: "r1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 5, output_tokens: 1 } } }),
    () => ({ status: 200, json: { id: "r2", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }], usage: { input_tokens: 5, output_tokens: 64 } } }),
  ]);
  try {
    const p = new OpenAICompatibleProvider(api.base, "k", "m", { input: 1, output: 5 }, "responses");
    const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], max_tokens: 64 };
    const a = await p.complete(req);
    assert.deepEqual(a.content, [{ type: "text", text: "hello" }]);
    assert.equal(a.stop_reason, "end_turn");
    assert.equal(a.cost_micro_usd, 10);
    const b = await p.complete(req);
    assert.equal(b.stop_reason, "max_tokens");
    assert.deepEqual(b.content, []);
    assert.equal(api.seen[0].body.tools, undefined);
    assert.deepEqual(api.seen[0].body.input, [{ role: "user", content: "hi" }]);
  } finally {
    await api.close();
  }
  const spec = await loadAgent("ui-ux-designer");
  assert.deepEqual(
    spec.provider.kind === "openai_compatible" && [spec.provider.model, spec.provider.api, spec.provider.usd_per_mtok],
    ["gpt-6.1-terra", "responses", { input: 1, output: 5 }],
  );
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    assert.equal((providerFor(spec, null) as any).api, "responses");
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("T33b: an empty assistant reply is dropped from Chat Completions history (null content without tool_calls is a 400)", async () => {
  const { toOpenAIMessages, toResponsesInput } = await import("./providers.ts");
  const msgs = [
    { role: "user" as const, content: "go" },
    { role: "assistant" as const, content: [] },
    { role: "user" as const, content: "You must finish by calling the submit_result tool with your result." },
  ];
  const oa = toOpenAIMessages("s", msgs);
  assert.deepEqual(oa.map((m: any) => m.role), ["system", "user", "user"]);
  assert.ok(oa.every((m: any) => m.content !== null || m.tool_calls));
  assert.deepEqual(toResponsesInput(msgs).map((m: any) => m.role), ["user", "user"]);
});
