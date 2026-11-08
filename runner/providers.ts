import path from "node:path";
import { writeFileSync } from "node:fs";
// Inference providers for the local runner: Naïve proxy (default), any OpenAI-compatible
// endpoint (fast external inference, local-only), and a scripted fake for tests.
import { createClient } from "@usenaive-sdk/managed-agents";
import type { AgentSpec } from "./spec.ts";
import type { Block, ImageBlock, Message, ModelReply, ModelRequest, Provider, ToolUseBlock } from "./types.ts";

export type NaiveClient = ReturnType<typeof createClient>;

// The SDK keeps no connection state of its own: it calls globalThis.fetch per request (createClient docs), so
// "recreating the client" after a network failure would change nothing. Node's fetch drops a socket that
// errored and expires idle keep-alive sockets after ~4 s, so the network backoff below (2 s, then >= 5 s)
// reaches fresh connections without touching Node's internal dispatcher.
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
  if (networkLevel(e) || ownTimeout(e)) return true;
  const msg = String(e?.message ?? e) + String(e?.cause?.code ?? "");
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|UND_ERR|aborted|timeout/i.test(msg);
}

/** Socket-level failure codes (undici / Node net) that mean "the request did not get an answer": retry on a new connection. */
export const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED",
]);

/** The socket code behind a fetch failure: e.code, e.cause.code, a nested cause, or the first code of a happy-eyeballs AggregateError. */
export function networkCode(e: any): string | null {
  for (let x = e, depth = 0; x && depth < 4; x = x.cause, depth++) {
    if (typeof x.code === "string" && x.code) return x.code;
    if (Array.isArray(x.errors)) {
      const c = x.errors.find((y: any) => typeof y?.code === "string")?.code;
      if (c) return c;
    }
  }
  return null;
}

/** A network-level failure: undici's TypeError("fetch failed") or a known socket code anywhere in the cause chain. No HTTP status. */
export function networkLevel(e: any): boolean {
  if (typeof (e?.status ?? e?.response?.status) === "number") return false;
  const code = networkCode(e);
  if (code && NETWORK_CODES.has(code)) return true;
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

/** Our own request deadline fired (AbortSignal.timeout → TimeoutError) or the request was aborted (AbortError). Retried at most once. */
export function ownTimeout(e: any): boolean {
  return e?.name === "TimeoutError" || e?.name === "AbortError";
}

/** Waits before network-level retries 1..5 at baseMs 1000 (6 tries ≈ 82 s, enough to ride out a dropped route; Nov 7 runs died
 *  on a 15 s schedule). Scaled by baseMs/1000 so tests run in milliseconds. */
export const NETWORK_WAITS_MS = [2000, 5000, 15_000, 30_000, 30_000];
/** Wait before the n-th network-level retry (1-based), jitter < 250 ms at baseMs 1000. */
export function networkWaitMs(n: number, baseMs: number): number {
  return Math.round(((NETWORK_WAITS_MS[Math.min(n, NETWORK_WAITS_MS.length) - 1] + Math.random() * 250) * baseMs) / 1000);
}
/** Default backoff base for withRetry (tests set it to 1). */
export const retryClock = { baseMs: 1000 };

/** Rate limits (429) reset per minute on gateways like Neon's (1.2M input tokens/min per account), so they get a
 *  slower, longer schedule than other transient errors: 15 s, 30 s, 45 s, then 60 s, up to RATE_LIMIT_TRIES tries. */
export const RATE_LIMIT_TRIES = 8;
/** The text of an OpenAI-style message content: a string, or an array of parts whose text parts are joined. */
export function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
      .filter(Boolean)
      .join("\n");
  if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text;
  return "";
}

export function retryWaitMs(e: unknown, attempt: number, baseMs: number): number {
  const status = (e as any)?.status ?? (e as any)?.response?.status;
  if (status === 429) return Math.min(15_000 * attempt, 60_000) + Math.floor(Math.random() * 1000);
  return baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5, baseMs = retryClock.baseMs): Promise<T> {
  let network = 0;
  let timeouts = 0;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as any)?.status ?? (e as any)?.response?.status;
      const net = networkLevel(e);
      const timeout = !net && ownTimeout(e);
      if (net) network++;
      if (timeout) timeouts++;
      const limit = status === 429 ? Math.max(tries, RATE_LIMIT_TRIES) : net ? Math.max(tries, NETWORK_WAITS_MS.length + 1) : tries;
      const code = networkCode(e);
      if (i >= limit || !isTransient(e) || timeouts > 1) {
        // name the socket code and the attempts in the run's error, so "fetch failed" is diagnosable from run.json
        if ((net || timeout) && e instanceof Error && !/\(after \d+ tries/.test(e.message)) {
          try {
            e.message = `${e.message} (${code ? `${code}, ` : ""}after ${i} tries over ${label})`;
          } catch {
            /* a DOMException's message is read-only: keep the original */
          }
        }
        throw e;
      }
      const wait = net
        ? networkWaitMs(network, baseMs)
        : retryWaitMs(e, i, baseMs);
      const kind = net ? "network error" : timeout ? "request timeout (retried once)" : "transient error";
      console.warn(`  ${label}: ${kind} (${String((e as any)?.message ?? e).slice(0, 120)}${code ? ` [${code}]` : ""}), retry ${i}/${limit - 1} in ${wait} ms`);
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
      ...(await this.billedOrEstimate(reply.id, reply.usage?.input_tokens ?? 0, reply.usage?.output_tokens ?? 0)),
      request_id: reply.id,
      model: reply.resolved_model ?? reply.model ?? this.model,
    };
  }

  /** Highest billed rate seen from this provider, micro-USD per token, for conservative estimates. */
  private maxRate = { input: 0, output: 0 };
  /** Waits between call-trace lookups; the trace can lag the reply (seen Nov 7: one trace never appeared within 5 s). */
  static TRACE_WAITS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
  /** Per-token ceiling used when nothing has been billed yet ($5 / $25 per MTok, above any model this studio uses). */
  static CEILING = { input: 5, output: 25 };

  // Replies carry no cost; the call trace does (docs/naive-notes.md). The budget math must never be blind:
  // wait for the trace, and if it never comes, charge a conservative estimate (marked) instead of failing a long run.
  private async billedOrEstimate(id: string, inTok: number, outTok: number): Promise<{ cost_micro_usd: number; cost_estimated?: true }> {
    let lastErr: unknown;
    for (const wait of NaiveProvider.TRACE_WAITS_MS) {
      try {
        const t: any = await this.client.proxy.call(id);
        if (typeof t.billed_micro_usd === "number") {
          const tok = inTok + outTok;
          if (tok > 0) {
            const r = t.billed_micro_usd / tok; // blended rate is a safe upper bound for either side's estimate
            this.maxRate = { input: Math.max(this.maxRate.input, r), output: Math.max(this.maxRate.output, r) };
          }
          return { cost_micro_usd: t.billed_micro_usd };
        }
      } catch (e) {
        lastErr = e;
      }
      await sleep(wait);
    }
    const rate = this.maxRate.input > 0 ? { input: this.maxRate.input * 1.5, output: this.maxRate.output * 1.5 } : NaiveProvider.CEILING;
    const est = Math.ceil(inTok * rate.input + outTok * rate.output);
    console.warn(`  ${this.label}: no billed cost for ${id} (${String(lastErr ?? "trace missing billed_micro_usd").slice(0, 120)}); charging a conservative estimate of ${est} micro-USD`);
    return { cost_micro_usd: est, cost_estimated: true };
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly label: string;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private price: { input: number; output: number },
    private api: "chat_completions" | "responses" = "chat_completions",
  ) {
    this.label = `openai:${model}`;
  }

  /** POST to the API with the shared retry policy; a non-2xx answer throws with its status. */
  private async post(route: string, payload: string): Promise<Response> {
    return withRetry(async () => {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: payload,
        signal: AbortSignal.timeout(300_000),
      });
      if (!r.ok) throw Object.assign(new Error(`${this.label} HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`), { status: r.status });
      return r;
    }, this.label);
  }

  /**
   * OpenAI Responses API (POST /responses), stateless: the whole history goes in `input` every turn (store: false).
   * Tool calls come back as `function_call` output items; results go back as `function_call_output`; a tool's
   * images ride a user message right after (same rule as Chat Completions). Function tools are sent with
   * strict: false, because strict mode demands schemas the runner's model-safe schemas don't promise.
   */
  private async completeResponses(req: ModelRequest): Promise<ModelReply> {
    const payload = JSON.stringify({
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages),
      max_output_tokens: req.max_tokens,
      store: false,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false })) } : {}),
    });
    if (process.env.ANYCO_PROVIDER_DEBUG_DIR) writeFileSync(path.join(process.env.ANYCO_PROVIDER_DEBUG_DIR, `req-${Date.now()}.json`), payload); // no key in the body
    const res = await this.post("/responses", payload);
    interface OutputItem {
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      call_id?: string;
      name?: string;
      arguments?: string;
    }
    const body = (await res.json()) as {
      id?: string; model?: string; status?: string; incomplete_details?: { reason?: string } | null;
      output?: OutputItem[]; usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content: Block[] = [];
    for (const item of body.output ?? []) {
      if (item.type === "message")
        for (const part of item.content ?? []) if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
      if (item.type === "function_call") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
        } catch {
          input = { _unparseable_arguments: String(item.arguments) };
        }
        content.push({ type: "tool_use", id: item.call_id ?? "", name: item.name ?? "", input });
      }
    }
    if (process.env.ANYCO_PROVIDER_DEBUG && content.length === 0) console.error(`[${this.label}] raw reply: ${JSON.stringify(body).slice(0, 4000)}`);
    const inTok = body.usage?.input_tokens ?? 0;
    const outTok = body.usage?.output_tokens ?? 0; // includes reasoning tokens, which are billed as output
    return {
      content,
      stop_reason: content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : body.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn",
      usage: { input_tokens: inTok, output_tokens: outTok },
      cost_micro_usd: Math.ceil(inTok * this.price.input + outTok * this.price.output),
      request_id: body.id ?? "",
      model: body.model ?? this.model,
    };
  }

  /** OpenAI's current models refuse `max_tokens` on Chat Completions and want `max_completion_tokens`; most other
   *  gateways take `max_tokens`. Start with max_tokens and switch for good on that exact 400 (a refused request is free). */
  private completionTokens = false;

  async complete(req: ModelRequest): Promise<ModelReply> {
    if (this.api === "responses") return this.completeResponses(req);
    const payloadFor = () => JSON.stringify({
      model: this.model,
      ...(this.completionTokens ? { max_completion_tokens: req.max_tokens } : { max_tokens: req.max_tokens }),
      messages: toOpenAIMessages(req.system, req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
        : {}),
    });
    const res = await withRetry(async () => {
      for (;;) {
        const payload = payloadFor();
        if (process.env.ANYCO_PROVIDER_DEBUG_DIR) writeFileSync(path.join(process.env.ANYCO_PROVIDER_DEBUG_DIR, `req-${Date.now()}.json`), payload); // no key in the body
        const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(300_000),
        });
        if (r.ok) return r;
        const text = await r.text();
        if (r.status === 400 && !this.completionTokens && /max_completion_tokens/.test(text) && /max_tokens/.test(text)) {
          this.completionTokens = true;
          console.warn(`  ${this.label}: the endpoint wants max_completion_tokens; resending with it`);
          continue;
        }
        throw Object.assign(new Error(`${this.label} HTTP ${r.status}: ${text.slice(0, 500)}`), { status: r.status });
      }
    }, this.label);
    // OpenAI chat-completions reply; parsed once, fields read from the typed shape.
    interface ChatChoiceMessage {
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    }
    interface ChatReply {
      choices?: Array<{ message?: ChatChoiceMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      id?: string;
      model?: string;
    }
    const body = (await res.json()) as ChatReply;
    const msg = body.choices?.[0]?.message ?? {};
    const content: Block[] = [];
    // content is a string on most gateways, but may arrive as an array of parts ({type:"text",text} or others);
    // String() on that wrote "[object Object]" into every Neon/Opus transcript (Nov 7). Keep only the text.
    const text = textOf(msg.content);
    if (text) content.push({ type: "text", text });
    if (process.env.ANYCO_PROVIDER_DEBUG && (typeof msg.content !== "string" || !(body.usage?.completion_tokens ?? 0)))
      console.error(`[${this.label}] raw reply: ${JSON.stringify(body).slice(0, 4000)}`);
    for (const tc of msg.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
      } catch {
        input = { _unparseable_arguments: String(tc.function?.arguments) };
      }
      content.push({ type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input });
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

const imagePart = (b: ImageBlock): Record<string, unknown> => {
  if (b.source.type !== "base64") throw new Error("toOpenAIMessages got an unexpanded image ref; call wireMessages() first");
  return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
};

export function toOpenAIMessages(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  let pendingToolImages: Array<{ id: string; img: ImageBlock }> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      // An empty reply (no text, no tool calls) is dropped: {content: null} without tool_calls is a 400 on
      // OpenAI ("expected a string, got null"), which killed ui-ux-designer 20261107-214504 at turn 17.
      if (!text && calls.length === 0) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          // OpenAI tool messages carry TEXT only (string or text parts) — image_url parts in a
          // `tool` message are refused or dropped by many gateways (R13 A1). Text stays on the
          // tool message; every image of this turn goes into one user message right after the
          // tool messages, each preceded by a text part naming the tool_call_id it belongs to.
          if (typeof b.content === "string") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
          else {
            const text = b.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            const images = b.content.filter((c): c is ImageBlock => c.type === "image");
            out.push({ role: "tool", tool_call_id: b.tool_use_id, content: images.length ? `${text}\n[image follows]` : text });
            for (const img of images) pendingToolImages.push({ id: b.tool_use_id, img });
          }
        } else if (b.type === "text") out.push({ role: "user", content: b.text });
        else if (b.type === "image") out.push({ role: "user", content: [imagePart(b)] });
      }
      if (pendingToolImages.length) {
        // Valid order: assistant tool_calls -> tool results -> user images (the turn's images).
        out.push({
          role: "user",
          content: pendingToolImages.flatMap(({ id, img }) => [{ type: "text", text: `image from tool_call ${id}` }, imagePart(img)]),
        });
        pendingToolImages = [];
      }
    }
  }
  return out;
}

const inputImage = (b: ImageBlock): Record<string, unknown> => {
  if (b.source.type !== "base64") throw new Error("toResponsesInput got an unexpanded image ref; call wireMessages() first");
  return { type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}` };
};

/**
 * Runner messages → Responses API input items. Assistant tool_use → function_call (call_id only: no item id, so the
 * API takes it as fresh input, not a reference to a stored item); tool_result → function_call_output (text);
 * a tool's images → one user message right after the outputs, each named by its call_id.
 */
export function toResponsesInput(messages: Message[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) out.push({ role: "assistant", content: text });
      for (const b of m.content)
        if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      continue;
    }
    const images: Array<{ id: string; img: ImageBlock }> = [];
    const parts: any[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        if (typeof b.content === "string") out.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
        else {
          const text = b.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          const imgs = b.content.filter((c): c is ImageBlock => c.type === "image");
          out.push({ type: "function_call_output", call_id: b.tool_use_id, output: imgs.length ? `${text}\n[image follows]` : text });
          for (const img of imgs) images.push({ id: b.tool_use_id, img });
        }
      } else if (b.type === "text") parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image") parts.push(inputImage(b));
    }
    if (images.length) out.push({ role: "user", content: images.flatMap(({ id, img }) => [{ type: "input_text", text: `image from tool_call ${id}` }, inputImage(img)]) });
    if (parts.length) out.push({ role: "user", content: parts });
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
  const baseUrl = process.env[p.base_url_env]?.trim() || p.base_url_default;
  const apiKey = process.env[p.api_key_env];
  if (!baseUrl || !apiKey) throw new Error(`${spec.name}: set ${baseUrl ? "" : `${p.base_url_env} and `}${p.api_key_env} in .env`);
  return new OpenAICompatibleProvider(baseUrl, apiKey, modelOverride ?? p.model, p.usd_per_mtok, p.api);
}
