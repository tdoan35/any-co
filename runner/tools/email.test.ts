import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPLS, type ToolContext } from "../../runner/tools/impl.ts";
import type { NaiveClient } from "../../runner/providers.ts";

interface SentCall { identityId: string; inboxId: string; body: { to: string[]; subject: string; text: string } }

const fakeNaive = (calls: SentCall[]): NaiveClient =>
  ({
    emails: {
      send: async (identityId: string, inboxId: string, body: SentCall["body"]) => {
        calls.push({ identityId, inboxId, body });
        return { object: "email_send", accepted: true, from: "studio@any-co.games", to: body.to, sent_at: "2026-11-07T21:30:00Z" };
      },
    },
  }) as unknown as NaiveClient;

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const IDS = { NAIVE_EMAIL_IDENTITY_ID: "id-1", NAIVE_EMAIL_INBOX_ID: "in-1" };
const ctxFor = (naive: NaiveClient | null): ToolContext => ({ workspace: "/nowhere", naive, agent: "community-outreach" });

test("email_send: one recipient, SDK shape, result reports what Naïve accepted", async () => {
  const calls: SentCall[] = [];
  await withEnv({ ...IDS, STUDIO_EMAIL_BLOCKLIST: undefined }, async () => {
    const out = await IMPLS.email_send.email_send.run({ to: "press@example.com", subject: "Demo build", body: "Here it is." }, ctxFor(fakeNaive(calls)));
    assert.equal(out.is_error, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { to: ["press@example.com"], subject: "Demo build", text: "Here it is." });
    assert.equal(calls[0].identityId, "id-1");
    assert.equal(calls[0].inboxId, "in-1");
    const r = JSON.parse(out.content);
    assert.equal(r.accepted, true);
    assert.equal(r.from, "studio@any-co.games");
  });
});

test("email_send: blocklist refuses addresses and whole domains, configurable via env", async () => {
  const calls: SentCall[] = [];
  await withEnv({ ...IDS, STUDIO_EMAIL_BLOCKLIST: "exact@blocked.example, @domain-blocked.example" }, async () => {
    const ctx = ctxFor(fakeNaive(calls));
    const exact = await IMPLS.email_send.email_send.run({ to: "exact@blocked.example", subject: "s", body: "b" }, ctx);
    assert.equal(exact.is_error, true);
    assert.match(exact.content, /blocklist/);
    const domain = await IMPLS.email_send.email_send.run({ to: "anyone@domain-blocked.example", subject: "s", body: "b" }, ctx);
    assert.equal(domain.is_error, true);
    const ok = await IMPLS.email_send.email_send.run({ to: "fine@ok.example", subject: "s", body: "b" }, ctx);
    assert.equal(ok.is_error, undefined);
    assert.equal(calls.length, 1); // only the allowed address went out
  });
});

test("email_send: missing identity/inbox env or missing Naïve client names what is missing", async () => {
  const calls: SentCall[] = [];
  await withEnv({ NAIVE_EMAIL_IDENTITY_ID: undefined, NAIVE_EMAIL_INBOX_ID: undefined }, async () => {
    const out = await IMPLS.email_send.email_send.run({ to: "a@b.example", subject: "s", body: "b" }, ctxFor(fakeNaive(calls)));
    assert.equal(out.is_error, true);
    assert.match(out.content, /NAIVE_EMAIL_IDENTITY_ID/);
    assert.match(out.content, /NAIVE_EMAIL_INBOX_ID/);
    assert.equal(calls.length, 0);
  });
  await withEnv({ ...IDS }, async () => {
    const out = await IMPLS.email_send.email_send.run({ to: "a@b.example", subject: "s", body: "b" }, ctxFor(null));
    assert.equal(out.is_error, true);
    assert.match(out.content, /NAIVE_API_KEY/);
  });
});

test("email_send: a Naïve send failure comes back as an error result", async () => {
  // Fake SDK client: throws an ApiError-shaped Error with a status, like the SDK does.
  const failing = { emails: { send: async () => { throw Object.assign(new Error("credit exhausted"), { status: 402 }); } } } as unknown as NaiveClient;
  await withEnv(IDS, async () => {
    const out = await IMPLS.email_send.email_send.run({ to: "a@b.example", subject: "s", body: "b" }, ctxFor(failing));
    assert.equal(out.is_error, true);
    assert.match(out.content, /402/);
    assert.match(out.content, /credit exhausted/);
  });
});
