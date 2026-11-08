import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RegistrySchema, RunEventSchema, RunSchema, TaskSchema, WeaveSnapshotSchema, RunEventPayloadSchemas } from "@fabric/contracts";
import { z } from "zod";
import { startServer } from "./index.ts";
import { buildRegistry } from "./registry.ts";
import type { AgentSpec } from "../../runner/spec.ts";
import { mapRun, parseTranscript, titleOf } from "./runs.ts";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();
const jl = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";

const start = { ts: ts(0), type: "start", agent: "toy-catalog-reporter", task: "Report the facts.\nSecond line.", limits: { run_cap: 50000 } };
const turn1 = [
  { ts: ts(1), type: "request", turn: 1, messages: 1 },
  { ts: ts(3), type: "reply", turn: 1, cost_micro_usd: 150, usage: { input_tokens: 900, output_tokens: 40 },
    content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "c1", name: "catalog_query", input: { command: "meta" } }] },
  { ts: ts(4), type: "tool", name: "catalog_query", input: {}, cost_micro_usd: 0, content: "line one\nline two" },
];
const done = [
  { ts: ts(5), type: "request", turn: 2, messages: 3 },
  { ts: ts(6), type: "reply", turn: 2, cost_micro_usd: 50, usage: { input_tokens: 1000 }, content: [{ type: "tool_use", id: "c2", name: "submit_result", input: {} }] },
  { ts: ts(7), type: "submit", ok: true },
  { ts: ts(7.5), type: "end", status: "done", spent_micro_usd: 200, turns: 2 },
];
const dept = () => "test";

test("mapRun: finished run becomes an accepted Run whose events and shapes satisfy the contract", () => {
  const m = mapRun("r1", parseTranscript(jl(start, ...turn1, ...done)), dept, T0 + 60_000)!;
  assert.equal(m.run.status, "accepted");
  assert.equal(m.run.costUsd, 0.0002);
  assert.equal(m.run.teamId, "team-test");
  assert.equal(m.run.segments.length, 2);
  assert.equal(m.task.title, "Report the facts.");
  assert.equal(titleOf("x".repeat(30) + " " + "y".repeat(80), "f").endsWith("…"), true);
  RunSchema.parse(m.run);
  TaskSchema.parse(m.task);
  for (const e of m.events) {
    RunEventSchema.parse(e);
    RunEventPayloadSchemas[e.type].parse(e.payload);
  }
  assert.deepEqual(m.events.map((e) => e.seq), m.events.map((_, i) => i));
  assert.equal(m.events.at(-1)!.type, "run.finished");
});

test("mapRun: no end line is running when fresh and stopped when stale; failures map to stopped/blocked", () => {
  const live = parseTranscript(jl(start, ...turn1));
  assert.equal(mapRun("r", live, dept, T0 + 10_000)!.run.status, "running");
  const dead = mapRun("r", live, dept, T0 + 3_600_000)!;
  assert.equal(dead.run.status, "stopped");
  assert.equal(dead.events.at(-1)!.type, "run.stopped");
  const over = parseTranscript(jl(start, ...turn1, { ts: ts(9), type: "end", status: "budget_exceeded", spent_micro_usd: 1, turns: 1 }));
  assert.equal(mapRun("r", over, dept, T0 + 20_000)!.run.status, "blocked");
  assert.equal(mapRun("r", parseTranscript(jl({ ts: ts(0), type: "request" })), dept), undefined);
});

test("mapRun: a chat turn is marked, titled Chat:, and kept out of the pulse (but shows presence while running)", async () => {
  const { buildWeave } = await import("./weave.ts");
  const id = "20261107-000000-studio-head-t2-ab12";
  const chatStart = { ...start, agent: "studio-head", task: "how are we doing?" };
  const m = mapRun(id, parseTranscript(jl(chatStart, ...done.slice(0, 0), { ts: ts(1), type: "request", turn: 1 })), dept, T0 + 5_000)!;
  assert.equal(m.chat, true);
  assert.equal(m.task.title, "Chat: how are we doing?");
  const live = buildWeave([m], ["studio-head"]);
  assert.equal(live.pulse.length, 0);
  assert.equal(live.presence[0].state, "working");
  const fin = mapRun(id, parseTranscript(jl(chatStart, { ts: ts(2), type: "end", status: "done", spent_micro_usd: 1, turns: 1 })), dept, T0 + 5_000)!;
  const after = buildWeave([fin], ["studio-head"]);
  assert.equal(after.pulse.length, 0);
  assert.equal(after.presence[0].state, "idle");
  assert.equal(mapRun("20261107-000000-market-analyst", parseTranscript(jl(start)), dept, T0 + 5_000)!.chat, false);
});

test("mapRun: a runner wrap_up becomes a visible note in the loop", () => {
  const m = mapRun("r", parseTranscript(jl(start, ...turn1, { ts: ts(4.5), type: "wrap_up", turn: 1, why: "70% of the run cap is spent", headroom: 1, max_call: 1 })), dept, T0 + 5_000)!;
  const note = m.events.find((e) => e.type === "tool.result" && String(e.payload.line).startsWith("wrap-up:"));
  assert.match(String(note?.payload.line), /70% of the run cap is spent/);
  RunEventSchema.parse(note);
});

test("parseTranscript skips a torn last line", () => {
  assert.equal(parseTranscript(jl(start) + '{"ts":"2026-11-0').length, 1);
});

test("server: routes validate against the contract, are read-only, and stream changes", async () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), "window-runs-"));
  try {
    mkdirSync(path.join(runsDir, "r-done"));
    writeFileSync(path.join(runsDir, "r-done", "transcript.jsonl"), jl(start, ...turn1, ...done));
    const live = path.join(runsDir, "r-live");
    mkdirSync(live);
    const liveStart = { ...start, ts: new Date().toISOString() };
    writeFileSync(path.join(live, "transcript.jsonl"), jl(liveStart));

    const srv = await startServer({ runsDir, port: 0 });
    const base = `http://127.0.0.1:${srv.port}/api`;
    const get = async (p: string) => (await fetch(base + p)).json();
    try {
      RegistrySchema.parse(await get("/registry"));
      const weave = WeaveSnapshotSchema.parse(await get("/weave"));
      assert.equal(weave.presence.find((p) => p.agentId === "toy-catalog-reporter")?.state, "working");
      const runs = z.array(RunSchema).parse(await get("/runs"));
      assert.deepEqual(runs.map((r) => r.id).sort(), ["r-done", "r-live"]);
      z.array(TaskSchema).parse(await get("/tasks"));
      z.array(RunEventSchema).parse(await get("/runs/r-done/events"));
      assert.equal((await fetch(`${base}/runs/nope`)).status, 404);
      assert.equal((await fetch(`${base}/reports/x`)).status, 404);
      assert.equal((await fetch(`${base}/runs`, { method: "POST", body: "{}" })).status, 405);

      const controller = new AbortController();
      const stream = await fetch(`${base}/stream`, { signal: controller.signal });
      const reader = stream.body!.getReader();
      await reader.read(); // ": connected"
      appendFileSync(path.join(live, "transcript.jsonl"), jl({ ts: new Date().toISOString(), type: "request", turn: 1 }));
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no SSE event within 3s")), 3000)),
      ]);
      assert.match(new TextDecoder().decode(chunk.value), /event: app/);
      controller.abort();
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

const fakeSpec = (name: string, dept: string) =>
  ({ name, dept, description: `${name} does things`, model: "m/x", runner: "local", system: "x".repeat(60), tools: {}, skills: [], budget: { cap_usd: 1, max_task_usd: 1, period: "day" } }) as unknown as AgentSpec;

test("registry: no invented lead or head; a head spec tops the org and is not drawn twice", () => {
  const noHead = buildRegistry([fakeSpec("a", "design"), fakeSpec("b", "design"), fakeSpec("c", "eng")], new Set());
  assert.equal(noHead.organizations[0].headId, "");
  assert.ok(noHead.teams.every((t) => t.members.every((m) => !m.lead)));
  assert.equal(noHead.organizations[0].slots.length, 2);
  assert.equal(noHead.teams.find((t) => t.id === "team-design")!.name, "Game Design");
  assert.equal(noHead.teams.find((t) => t.id === "team-eng")!.name, "Engineering");
  assert.equal(noHead.agents.find((a) => a.agent.id === "c")!.agent.role, "Engineering");
  assert.equal(noHead.agents.find((a) => a.agent.id === "a")!.agent.traits[0], "Game Design");
  const withToy = buildRegistry([fakeSpec("a", "design"), fakeSpec("toy", "test")], new Set());
  assert.deepEqual(withToy.organizations[0].slots.map((s) => s.teamId), ["team-design"]);
  assert.ok(withToy.teams.some((t) => t.id === "team-test"));
  RegistrySchema.parse(noHead);

  const withHead = buildRegistry([fakeSpec("studio-head", "head"), fakeSpec("a", "design")], new Set(["a"]));
  assert.equal(withHead.organizations[0].headId, "studio-head");
  assert.deepEqual(withHead.organizations[0].slots.map((s) => s.teamId), ["team-design"]);
  assert.equal(withHead.teams.find((t) => t.id === "team-design")!.status, "active");
  assert.deepEqual(buildRegistry([], new Set()).organizations, []);
});

test("server: /api/art-gallery lists repos and serves a gallery png (the route strips both api/ and art-gallery/)", async () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), "window-runs-"));
  const gamesRoot = mkdtempSync(path.join(os.tmpdir(), "window-games-"));
  try {
    const repo = path.join(gamesRoot, "g1");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(repo, "art", "gallery", "hero"), { recursive: true });
    writeFileSync(path.join(repo, "art", "gallery", "hero", "1-pixellab-accepted.png"), "PNGDATA");
    writeFileSync(path.join(repo, "art", "gallery", "gallery.json"), JSON.stringify({ entries: [] }));
    const srv = await startServer({ runsDir, gamesRoot, port: 0 });
    const base = `http://127.0.0.1:${srv.port}/api`;
    try {
      const idx = await fetch(`${base}/art-gallery`);
      assert.equal(idx.status, 200);
      assert.deepEqual(((await idx.json()) as { repos: string[] }).repos, ["g1"]);
      const png = await fetch(`${base}/art-gallery/g1/png/gallery/hero/1-pixellab-accepted.png`);
      assert.equal(png.status, 200);
      assert.equal(await png.text(), "PNGDATA");
      assert.equal((await fetch(`${base}/art-gallery/nope`)).status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(gamesRoot, { recursive: true, force: true });
  }
});
