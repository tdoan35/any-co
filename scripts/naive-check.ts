// Health check for the Naïve connection: balance, model count, one tiny proxy call and its billed cost.
// Usage: node --env-file=.env --import tsx scripts/naive-check.ts [model]   (costs ~20 micro-USD)
import { createClient } from "@usenaive-sdk/managed-agents";

const apiKey = process.env.NAIVE_API_KEY;
if (!apiKey) throw new Error("NAIVE_API_KEY not set (see .env)");
const c = createClient({ apiKey, baseUrl: process.env.NAIVE_BASE_URL ?? "https://api.vetta.sh" });
const model = process.argv[2] ?? "z-ai/glm-5.3-flash";

const bal = await c.credits.show();
console.log(`balance: $${(bal.balance_micro_usd / 1e6).toFixed(4)} (${bal.mode})`);
let n = 0, after: string | undefined;
do { const r = await c.models.list({ limit: 100, after }); n += r.data.length; after = r.has_more ? (r.next_cursor ?? undefined) : undefined; } while (after);
console.log(`models: ${n}`);
const t0 = Date.now();
const reply = await c.proxy.messages({ model, max_tokens: 64, messages: [{ role: "user", content: "Reply with the word ok." }] });
const ms = Date.now() - t0;
const trace = await c.proxy.call(reply.id);
console.log(`proxy ${model}: ${ms} ms, stop=${reply.stop_reason}, billed=${trace.billed_micro_usd} micro-USD`);
