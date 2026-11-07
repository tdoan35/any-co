// Inference providers for the local runner: Naïve proxy (default), any OpenAI-compatible
// endpoint (fast external inference, local-only), and a scripted fake for tests.
import { createClient } from "@usenaive-sdk/managed-agents";
import type { AgentSpec } from "./spec.ts";
import type { Block, Message, ModelReply, ModelRequest, Provider } from "./types.ts";

export type NaiveClient = ReturnType<typeof createClient>;

export function naiveClient(): NaiveClient {
  const apiKey = process.env.NAIVE_API_KEY;
  if (!apiKey) throw new Error("NAIVE_API_KEY is not set (see .env)");
  return createClient({ apiKey, baseUrl: process.env.NAIVE_BASE_URL ?? "https://api.vetta.sh" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Network errors, 429, and 5xx are retried; anything else (bad request, budget refusal) is not. */
export function isTransient(e: any): boolean {
  const status = e?.status ?? e?.response?.status;
  if (typeof status === "number") return status === 429 || status === 408 || status >= 500;
  const msg = String(e?.message ?? e) + String(e?.cause?.code ?? "");
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|UND_ERR|aborted|timeout/i.test(msg);
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5, baseMs = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !isTransient(e)) throw e;
      const wait = baseMs * 2 ** (i - 1) + Math.floor(Math.random() * 250);
      console.warn(`  ${label}: transient error (${String((e as any)?.message ?? e).slice(0, 120)}), retry ${i}/${tries - 1} in ${wait} ms`);
      await sleep(wait);
    }
  }
}

export class NaiveProvider implements Provider {
  readonly label: string;
  constructor(private client: NaiveClient, private model: string, private window: "immediate" | "priority" | "loose") {
    this.label = `naive:${model}`;
  }

  async complete(req: ModelRequest): Promise<ModelReply> {
    // Retrying is safe: a failed call is not billed, and the SDK sends a fresh idempotency key.
    const reply: any = await withRetry(
      () =>
        this.client.proxy.messages(
          {
            model: this.model,
            max_tokens: req.max_tokens,
            system: req.system,
            messages: req.messages as any,
            ...(req.tools.length ? { tools: req.tools as any } : {}),
          },
          this.window,
        ),
      this.label,
    );
    return {
      content: (reply.content ?? []).filter((b: any) => b.type === "text" || b.type === "tool_use") as Block[],
      stop_reason: reply.stop_reason ?? null,
      usage: { input_tokens: reply.usage?.input_tokens ?? 0, output_tokens: reply.usage?.output_tokens ?? 0 },
      cost_micro_usd: await this.billed(reply.id),
      request_id: reply.id,
      model: reply.resolved_model ?? reply.model ?? this.model,
    };
  }

  // Replies carry no cost; the call trace does (docs/naive-notes.md). Without a cost the budget
  // math is blind, so a missing trace fails the call instead of guessing.
  private async billed(id: string): Promise<number> {
    let lastErr: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        const t: any = await this.client.proxy.call(id);
        if (typeof t.billed_micro_usd === "number") return t.billed_micro_usd;
      } catch (e) {
        lastErr = e;
      }
      await sleep(250 * (i + 1));
    }
    throw new Error(`no billed cost for ${id} after retries: ${String(lastErr ?? "trace missing billed_micro_usd")}`);
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly label: string;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private price: { input: number; output: number },
  ) {
    this.label = `openai:${model}`;
  }

  async complete(req: ModelRequest): Promise<ModelReply> {
    const res = await withRetry(async () => {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.max_tokens,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
          : {}),
      }),
      signal: AbortSignal.timeout(300_000),
      });
      if (!r.ok) throw Object.assign(new Error(`${this.label} HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`), { status: r.status });
      return r;
    }, this.label);
    const body: any = await res.json();
    const msg = body.choices?.[0]?.message ?? {};
    const content: Block[] = [];
    if (msg.content) content.push({ type: "text", text: String(msg.content) });
    for (const tc of msg.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = { _unparseable_arguments: String(tc.function?.arguments) };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
    }
    const inTok = body.usage?.prompt_tokens ?? 0;
    const outTok = body.usage?.completion_tokens ?? 0;
    const finish = body.choices?.[0]?.finish_reason;
    return {
      content,
      stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
      usage: { input_tokens: inTok, output_tokens: outTok },
      cost_micro_usd: Math.ceil(inTok * this.price.input + outTok * this.price.output), // usd/Mtok == micro-usd/tok
      request_id: body.id ?? "",
      model: body.model ?? this.model,
    };
  }
}

export function toOpenAIMessages(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

/** Scripted provider for tests: each step returns the next reply (or computes it from the request). */
export class FakeProvider implements Provider {
  readonly label = "fake";
  readonly requests: ModelRequest[] = [];
  constructor(private steps: Array<Partial<ModelReply> | ((req: ModelRequest) => Partial<ModelReply>)>, private costEach = 1000) {}

  async complete(req: ModelRequest): Promise<ModelReply> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("FakeProvider: no more scripted replies");
    const r = typeof step === "function" ? step(req) : step;
    return {
      content: r.content ?? [{ type: "text", text: "(fake)" }],
      stop_reason: r.stop_reason ?? "end_turn",
      usage: r.usage ?? { input_tokens: 10, output_tokens: 10 },
      cost_micro_usd: r.cost_micro_usd ?? this.costEach,
      request_id: r.request_id ?? `fake_${this.requests.length}`,
      model: "fake",
    };
  }
}

export function providerFor(spec: AgentSpec, client: NaiveClient | null, modelOverride?: string): Provider {
  const p = spec.provider;
  if (p.kind === "naive") {
    if (!client) throw new Error("naive provider needs a Naïve client");
    return new NaiveProvider(client, modelOverride ?? spec.model, spec.window);
  }
  const baseUrl = process.env[p.base_url_env];
  const apiKey = process.env[p.api_key_env];
  if (!baseUrl || !apiKey) throw new Error(`${spec.name}: set ${p.base_url_env} and ${p.api_key_env} in .env`);
  return new OpenAICompatibleProvider(baseUrl, apiKey, modelOverride ?? p.model, p.usd_per_mtok);
}
