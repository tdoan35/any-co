// Images in the runner (T8 Part A): PNG codec, art_view (image_view), wire shapes for both
// providers, transcript-without-base64, and exact resume after an image turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./load.ts";
import { FakeProvider, NaiveProvider, toOpenAIMessages } from "./providers.ts";
import { runAgent } from "./run.ts";
import { resumeRun } from "./resume.ts";
import { wireMessages } from "./images.ts";
import { decodePng, encodePng, upscaleNearest } from "./tools/png.ts";
import { IMPLS } from "./tools/impl.ts";
import type { ToolUseBlock } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "__fixtures__", "agents");
const CRASH = path.join(HERE, "__fixtures__", "crash-run.ts");
const PNG = readFileSync(path.join(HERE, "__fixtures__", "img", "tiny.png")); // written by Python, independent ground truth
const tmp = () => mkdtempSync(path.join(tmpdir(), "anyco-img-"));
const use = (name: string, input: Record<string, unknown>, id: string): ToolUseBlock => ({ type: "tool_use", id, name, input });

test("png codec: decodes ground truth exactly, round-trips, upscales, refuses junk", () => {
  const img = decodePng(PNG);
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.deepEqual(Array.from(img.data.subarray(4 * 4, 4 * 4 + 4)), [255, 0, 255, 128]); // row 1 col 0
  assert.deepEqual(Array.from(img.data.subarray(7 * 4, 7 * 4 + 4)), [10, 20, 30, 40]); // row 1 col 3
  assert.deepEqual(Array.from(img.data.subarray(11 * 4, 11 * 4 + 4)), [255, 255, 255, 0]); // row 2 col 3
  const again = decodePng(encodePng(img));
  assert.equal(again.width, 4);
  assert.deepEqual(Array.from(again.data), Array.from(img.data));
  // Nearest-neighbour: each pixel becomes a k×k block.
  const up = upscaleNearest(img, 2);
  assert.equal(up.width, 8);
  assert.equal(up.height, 6);
  assert.deepEqual(Array.from(up.data.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)), [0, 255, 255, 0]); // (2,2) up = (1,1) source
  assert.throws(() => decodePng(Buffer.from("definitely not a png")), /not a PNG/);
  const corrupt = Buffer.from(PNG);
  corrupt[corrupt.length - 5] ^= 0xff; // break the IEND CRC
  assert.throws(() => decodePng(corrupt), /CRC/);
});

test("art_view: image block + size, content-addressed copy, escape and cap refused", async () => {
  const artView = IMPLS.image_view.art_view;
  const workspace = tmp();
  writeFileSync(path.join(workspace, "img.png"), PNG);
  const runsDir = tmp();
  const out = await artView.run({ path: "img.png" }, { workspace, naive: null, runsDir, run_id: "r-img" });
  assert.equal(out.is_error, undefined);
  assert.match(out.content, /^4×3 PNG, \d+ bytes, sha256 [0-9a-f]{16}$/);
  const ref = out.image?.source;
  assert.equal(ref?.type, "ref");
  const copy = path.join(runsDir, "r-img", "images", `${ref?.sha256}.png`);
  assert.equal(existsSync(copy), true);
  assert.deepEqual(readFileSync(copy), PNG); // exact bytes sent are the bytes stored

  // Upscale: 4x3 at k=8 fits (32x24); a 600-wide image cannot upscale at all under the 1024 cap.
  const wide = encodePng({ width: 600, height: 2, data: new Uint8Array(600 * 2 * 4).fill(7) });
  writeFileSync(path.join(workspace, "wide.png"), wide);
  const upOut = await artView.run({ path: "wide.png", upscale: 8 }, { workspace, naive: null, runsDir, run_id: "r-img" });
  assert.match(upOut.content, /^600×2 PNG/); // k clamped to 1: no upscale note
  const small = await artView.run({ path: "img.png", upscale: 2 }, { workspace, naive: null, runsDir, run_id: "r-img" });
  assert.match(small.content, /8×6 \(x2 nearest-neighbour\)/);
  const upBytes = readFileSync(path.join(runsDir, "r-img", "images", `${(small.image?.source as { sha256: string }).sha256}.png`));
  const decoded = decodePng(upBytes);
  assert.equal(decoded.width, 8);

  // Path escape and size cap.
  const escape = await artView.run({ path: "../img.png" }, { workspace, naive: null, runsDir, run_id: "r-img" });
  assert.equal(escape.is_error, true);
  assert.match(escape.content, /escapes the workspace/);
  const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024 + 1)]);
  writeFileSync(path.join(workspace, "big.png"), big);
  const capped = await artView.run({ path: "big.png" }, { workspace, naive: null, runsDir, run_id: "r-img" });
  assert.equal(capped.is_error, true);
  assert.match(capped.content, /too large/);
});

test("run loop: image reaches both providers in the right wire shape; transcript keeps only refs", async () => {
  const spec = await loadAgent("image-agent", FIX);
  const runsDir = tmp();
  const workspace = path.join(runsDir, "w1", "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "img.png"), PNG);
  const fake = new FakeProvider([
    { content: [use("art_view", { path: "img.png" }, "a1")] },
    { content: [use("submit_result", { answer: "red pixel in the corner" }, "s1")] },
  ]);
  const r = await runAgent(spec, { task: "t", provider: fake, naive: null, runsDir, runId: "w1" });
  assert.equal(r.status, "done");
  // FakeProvider gets the Anthropic wire shape: text + base64 image inside tool_result.
  const last = fake.requests[1].messages.at(-1)!;
  assert.equal(typeof last.content, "object");
  const parts = last.content as Array<Record<string, unknown>>;
  const tr = parts.find((p) => p.type === "tool_result") as { content: Array<Record<string, unknown>> };
  assert.equal(tr.content[0].type, "text");
  const img = tr.content[1] as { type: string; source: { type: string; media_type: string; data: string } };
  assert.equal(img.type, "image");
  assert.equal(img.source.type, "base64");
  assert.equal(img.source.media_type, "image/png");
  assert.deepEqual(Buffer.from(img.source.data, "base64"), PNG);

  // The transcript never carries base64: the msg event holds the ref, lines stay small.
  const lines = readFileSync(path.join(runsDir, "w1", "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.every((l) => l.length < 4000), "transcript lines must stay small (no base64)");
  assert.ok(lines.every((l) => !l.includes('"type":"base64"')));
  const msgLine = lines.map((l) => JSON.parse(l)).find((e) => e.type === "msg" && e.role === "user");
  const ref = (msgLine.content[0].content as Array<Record<string, unknown>>)[1] as { type: string; source: { type: string } };
  assert.equal(ref.type, "image");
  assert.equal(ref.source.type, "ref");

  // OpenAI translation: image_url data parts in the tool message; text-only results stay strings.
  const openai = toOpenAIMessages("sys", fake.requests[1].messages);
  const toolMsg = openai.find((m) => m.role === "tool") as { content: Array<Record<string, unknown>> };
  assert.equal(toolMsg.content[0].type, "text");
  assert.equal(toolMsg.content[1].type, "image_url");
  assert.match((toolMsg.content[1].image_url as { url: string }).url, /^data:image\/png;base64,/);
  assert.deepEqual(
    toOpenAIMessages("s", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "plain" }] }])[1],
    { role: "tool", tool_call_id: "t", content: "plain" },
  );
  const userImg = toOpenAIMessages("s", [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "eHg=" } }] }])[1] as { role: string; content: Array<Record<string, unknown>> };
  assert.equal(userImg.role, "user");
  assert.equal(userImg.content[0].type, "image_url");

  // NaiveProvider passes the Anthropic shape through untouched (stub client, no network).
  const sent: unknown[] = [];
  const stub = {
    proxy: {
      messages: async (body: unknown) => {
        sent.push(body);
        return { id: "req-1", content: [{ type: "text", text: "seen" }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
      call: async () => ({ billed_micro_usd: 1 }),
    },
  };
  const naive = new NaiveProvider(stub as never, "m", "immediate");
  const reply = await naive.complete({ system: "s", messages: wireMessages(fake.requests[1].messages), tools: [], max_tokens: 10 });
  assert.equal(reply.content[0].type, "text");
  const body = sent[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  const wireTr = (body.messages.at(-1)!.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result") as { content: Array<Record<string, unknown>> };
  const wireImg = wireTr.content.find((b) => b.type === "image") as { source: { type: string; data: string } };
  assert.equal(wireImg.source.type, "base64");
  assert.deepEqual(Buffer.from(wireImg.source.data, "base64"), PNG);
});

test("crash after an image turn: resume rebuilds the identical image from the run-dir copy", async () => {
  const spec = await loadAgent("image-agent", FIX);
  const runsDir = tmp();
  const steps = [
    { content: [use("art_view", { path: "img.png" }, "a1")] },
    { content: [use("submit_result", { answer: "ok" }, "s1")] },
  ];
  const child = spawnSync(process.execPath, ["--import", "tsx", CRASH, runsDir, "msg:user", JSON.stringify(steps), "1", "image-agent"], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL");
  const runId = readdirSync(runsDir).find((d) => d !== "spend.jsonl")!;
  assert.equal(runId, "crash-image-agent");
  const imagesDir = path.join(runsDir, runId, "images");
  assert.equal(readdirSync(imagesDir).length, 1);
  const copyAbs = path.join(imagesDir, readdirSync(imagesDir)[0]);
  assert.deepEqual(readFileSync(copyAbs), PNG);

  // The workspace file changes after the crash; the resume must still send the original bytes.
  writeFileSync(path.join(runsDir, runId, "workspace", "img.png"), encodePng({ width: 2, height: 2, data: new Uint8Array(16) }));
  const fake = new FakeProvider([{ content: [use("submit_result", { answer: "still red" }, "s2")] }]);
  const r = await resumeRun(spec, runId, { provider: fake, naive: null, runsDir });
  assert.equal(r.status, "done");
  const last = fake.requests[0].messages.at(-1)!;
  const tr = (last.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result") as { content: Array<Record<string, unknown>> };
  const img = tr.content[1] as { source: { type: string; data: string } };
  assert.equal(img.source.type, "base64");
  assert.deepEqual(Buffer.from(img.source.data, "base64"), PNG); // identical to what was sent pre-crash
  // And the transcript still has no base64 after the resume.
  const lines = readFileSync(path.join(runsDir, runId, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.every((l) => l.length < 4000 && !l.includes('"type":"base64"')));
});
