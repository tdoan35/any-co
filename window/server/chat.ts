// Chat with the Studio Head, on Fabric's durable-session protocol (window/packages/contracts sessions.ts).
//
// A session is an append-only event log (runs/chat/<id>/events.jsonl) that the UI follows over SSE.
// Each human message runs ONE agent turn through the real local runner (same budget, kill switch and spend
// ledger as every other run; the turn shows up in runs/ and on the Work page). Conversation memory is the
// log itself: earlier user/assistant text is passed to the runner as history.
//
// Protocol notes the UI depends on:
//  - the UI ends a turn at the FIRST `agent.message` after its own `message.received`, so a turn emits
//    exactly one: the final answer. Tool calls come before it; intermediate model text goes out as `delta` frames.
//  - the UI pairs a message with `message.received.platformMessageId` (idempotent post).
//
// Rule 4 (CLAUDE.md): every human message after the event starts is appended to the studio ledger as an
// intervention (tools/ledger). Rule 7: a crash mid-turn is detected on startup and closed with an
// explanatory reply instead of leaving a thread that never answers.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectThread, type Session, type SessionDelta, type SessionEvent, type SessionThreadMessage } from "@fabric/contracts";
import { denyAll, runAgent } from "../../runner/run.ts";
import type { AgentSpec } from "../../runner/spec.ts";
import type { Block, Message, Provider } from "../../runner/types.ts";
import type { Board } from "../../runner/board/index.ts";
import type { NaiveClient } from "../../runner/providers.ts";
import { append as ledgerAppend, LEDGER_FILE, read as ledgerRead, type DecisionEntry, type InterventionEntry } from "../../tools/ledger/ledger.ts";
import { titleCase } from "./registry.ts";

/** 1:00 PM PT on Sat Nov 7 2026 (PST, UTC-8). Messages before this are practice, not interventions. */
export const DEFAULT_EVENT_START = "2026-11-07T21:00:00.000Z";
const HISTORY_MESSAGES = 20;
const HISTORY_CHARS = 24_000;
const TOOL_RESULT_CLIP = 2_000;

export class ChatError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ChatOptions {
  chatDir: string;
  runsDir: string;
  specs: () => AgentSpec[];
  /** Throws a readable error when no provider can be built (e.g. no API key). */
  providerFor: (spec: AgentSpec) => Provider;
  naive: NaiveClient | null;
  ledgerFile?: string;
  /** The studio board, so chat turns can use board_* tools on the same board as the loop. */
  board?: Board | null;
  eventStart?: string;
  now?: () => Date;
  /** Called after any session event is appended (the server turns this into an SSE `session.message`). */
  onChange?: (sessionId: string, messageId: string) => void;
}

type Frame = { kind: "event"; event: SessionEvent } | { kind: "delta"; delta: SessionDelta };
interface LiveSession {
  id: string;
  agentId: string;
  incognito: boolean;
  createdAt: string;
  /** Fixed row title (the seeded lead threads); derived from the first message otherwise. */
  title?: string;
  /** Seeded lead threads live in memory until their first event writes them to disk. */
  materialized: boolean;
  events: SessionEvent[];
  subscribers: Set<(f: Frame) => void>;
  queue: Promise<void>;
  turns: number;
}

/**
 * The standing lead-agent threads in the sidebar — one per department voice, mock for now:
 * each seeds in memory with a greeting and becomes a real persisted thread on the first
 * message sent in it (that message runs that lead's own spec, like any chat turn).
 */
const LEAD_THREADS: Array<{ dept: string; ageMin: number; greeting: string }> = [
  { dept: "head", ageMin: 18, greeting: "Studio Head here — ask me for the pulse, the board, or where the night went." },
  { dept: "greenlight", ageMin: 60, greeting: "Greenlight Chair here — I can walk you through the shortlist and the pick." },
  { dept: "design", ageMin: 180, greeting: "Game Design Director here — ask me about the design doc or the latest playtest." },
  { dept: "art", ageMin: 480, greeting: "Art Director here — palette locks, sprite sheets, art review: what do you need?" },
  { dept: "marketing", ageMin: 26 * 60, greeting: "Marketing Lead here — store page, posts, launch timing: ask away." },
];

const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

export class ChatEngine {
  private sessions = new Map<string, LiveSession>();
  private readonly now: () => Date;
  private readonly eventStart: number;
  private readonly ledgerFile: string;

  constructor(private readonly opts: ChatOptions) {
    this.now = opts.now ?? (() => new Date());
    this.eventStart = Date.parse(opts.eventStart ?? DEFAULT_EVENT_START);
    this.ledgerFile = opts.ledgerFile ?? LEDGER_FILE;
    this.loadFromDisk();
    this.seedLeadThreads();
  }

  /** One in-memory thread per lead department, so the sidebar opens onto voices, not session debris. */
  private seedLeadThreads() {
    const specs = this.opts.specs();
    for (const lead of LEAD_THREADS) {
      // A department can hold more than the lead (feasibility-critic, community-outreach):
      // the thread belongs to the role-named spec, falling back to the department's only member.
      const spec = specs.find((sp) => sp.dept === lead.dept && /(head|chair|director|lead)$/.test(sp.name))
        ?? specs.find((sp) => sp.dept === lead.dept);
      if (!spec) continue;
      const id = `lead-${spec.name}`;
      // Already on disk: the thread was seeded on an earlier boot and then messaged.
      if (this.sessions.has(id)) continue;
      const createdAt = new Date(this.now().getTime() - lead.ageMin * 60_000).toISOString();
      const greeting: SessionEvent = { seq: 1, type: "agent.message", class: "fact", payload: { text: lead.greeting }, ts: createdAt };
      this.sessions.set(id, {
        id, agentId: spec.name, incognito: false, createdAt, title: titleCase(spec.name),
        materialized: false, events: [greeting], subscribers: new Set(), queue: Promise.resolve(), turns: 0,
      });
    }
  }

  // ---- persistence ---------------------------------------------------------------------------------

  private loadFromDisk() {
    if (!existsSync(this.opts.chatDir)) return;
    for (const d of readdirSync(this.opts.chatDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const dir = path.join(this.opts.chatDir, d.name);
        const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as { agentId: string; incognito: boolean; createdAt: string; title?: string };
        const events: SessionEvent[] = [];
        const file = path.join(dir, "events.jsonl");
        if (existsSync(file)) {
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line) as SessionEvent); } catch { /* torn last line */ }
          }
        }
        const s: LiveSession = { id: d.name, ...meta, materialized: true, events, subscribers: new Set(), queue: Promise.resolve(), turns: events.filter((e) => e.type === "message.received").length };
        this.sessions.set(s.id, s);
        // Crash recovery: the last human message never got its answer.
        const lastUser = [...events].reverse().find((e) => e.type === "message.received");
        const lastReply = [...events].reverse().find((e) => e.type === "agent.message");
        if (lastUser && (!lastReply || lastReply.seq < lastUser.seq)) {
          this.append(s, "agent.message", { text: "I was interrupted by a restart before I could answer that. Please send it again." });
        }
      } catch (e) {
        console.warn(`[chat] skipping unreadable session ${d.name}: ${(e as Error).message}`);
      }
    }
  }

  private append(s: LiveSession, type: string, payload: Record<string, unknown>, cls: "fact" | "telemetry" = "fact"): SessionEvent {
    if (!s.materialized) this.materialize(s);
    const event: SessionEvent = { seq: (s.events.at(-1)?.seq ?? 0) + 1, type, class: cls, payload, ts: this.now().toISOString() };
    s.events.push(event);
    appendFileSync(path.join(this.opts.chatDir, s.id, "events.jsonl"), JSON.stringify(event) + "\n");
    for (const sub of s.subscribers) sub({ kind: "event", event });
    this.opts.onChange?.(s.id, `msg:${event.seq}`);
    return event;
  }

  /** A seeded lead thread's first event turns it into a real one: write what memory holds, then keep appending. */
  private materialize(s: LiveSession) {
    const dir = path.join(this.opts.chatDir, s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ agentId: s.agentId, incognito: s.incognito, createdAt: s.createdAt, ...(s.title ? { title: s.title } : {}) }));
    if (s.events.length) writeFileSync(path.join(dir, "events.jsonl"), s.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    s.materialized = true;
  }

  // ---- commands ------------------------------------------------------------------------------------

  create(agentId: string, incognito = false): string {
    if (!this.opts.specs().some((sp) => sp.name === agentId)) throw new ChatError(404, `no agent "${agentId}"`);
    const id = newId();
    const dir = path.join(this.opts.chatDir, id);
    mkdirSync(dir, { recursive: true });
    const meta = { agentId, incognito, createdAt: this.now().toISOString() };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    this.sessions.set(id, { id, ...meta, materialized: true, events: [], subscribers: new Set(), queue: Promise.resolve(), turns: 0 });
    return id;
  }

  /** Records the human message (and the intervention), then runs the turn in the background. */
  post(sessionId: string, input: { clientMessageId: string; text: string }): { seq: number } {
    const s = this.get(sessionId);
    const dup = s.events.find((e) => e.type === "message.received" && (e.payload as { platformMessageId?: string }).platformMessageId === input.clientMessageId);
    if (dup) return { seq: dup.seq };
    const received = this.append(s, "message.received", { text: input.text, platformMessageId: input.clientMessageId });
    this.recordIntervention(s, input.text);
    s.turns++;
    s.queue = s.queue.then(() => this.turn(s, received, s.turns)).catch((e) => console.error("[chat] turn crashed", e));
    return { seq: received.seq };
  }

  private recordIntervention(s: LiveSession, message: string) {
    if (this.now().getTime() < this.eventStart) return; // practice: not an intervention yet
    const entry: InterventionEntry = {
      kind: "intervention",
      ts: this.now().toISOString(),
      who: "operator",
      action: `chat message to ${s.agentId}`,
      reason: message.length > 300 ? `${message.slice(0, 300)}…` : message,
      category: "steering", // a human directing an agent (T17)
    };
    ledgerAppend(entry, this.ledgerFile);
  }

  // ---- the turn ------------------------------------------------------------------------------------

  private async turn(s: LiveSession, received: SessionEvent, turnNo: number) {
    const userText = text((received.payload as { text?: string }).text) ?? "";
    const spec = this.opts.specs().find((sp) => sp.name === s.agentId);
    let callNo = 0;
    try {
      if (!spec) throw new Error(`agent "${s.agentId}" no longer exists`);
      const provider = this.opts.providerFor(spec);
      const result = await runAgent(spec, {
        runId: `${localStamp(this.now())}-${spec.name}-t${turnNo}-${s.id.slice(-4)}`, // unique per turn: the default is per-second
        task: userText,
        history: this.historyBefore(s, received.seq),
        provider,
        naive: this.opts.naive,
        runsDir: this.opts.runsDir,
        approver: denyAll, // the Studio Head's chat tools are read-only; nothing here may ask a human mid-turn
        board: this.opts.board ?? undefined,
        onEvent: (type, data) => {
          if (type === "reply") {
            callNo++;
            const blocks = (Array.isArray(data.content) ? data.content : []) as Block[];
            const uses = blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
            for (const u of uses) this.append(s, "tool.call", { callId: u.id, tool: u.name, args: u.input, argsText: JSON.stringify(u.input) });
            const said = blocks.flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text] : [])).join("\n");
            // Mid-turn narration streams as a delta; the final answer lands once, as `agent.message`.
            if (said && uses.length) for (const sub of s.subscribers) sub({ kind: "delta", delta: { turn: turnNo, callNo, text: plainText(said) } });
          } else if (type === "tool") {
            const callId = text(data.id);
            const body = text(data.error) ?? text(data.content) ?? "";
            this.append(s, "tool.completed", { callId, result: body.length > TOOL_RESULT_CLIP ? `${body.slice(0, TOOL_RESULT_CLIP)}…` : body, ...(data.error ? { error: true } : {}) });
          }
        },
      });
      this.append(s, "agent.message", { text: plainText(finalText(result)) });
    } catch (e) {
      this.append(s, "agent.message", { text: `I couldn't answer that: ${(e as Error).message}` });
    }
  }

  /** Earlier user/assistant text as runner messages (alternating, bounded). */
  private historyBefore(s: LiveSession, beforeSeq: number): Message[] {
    const out: Message[] = [];
    for (const e of s.events) {
      if (e.seq >= beforeSeq) break;
      const t = text((e.payload as { text?: string }).text);
      if (t === undefined) continue;
      const role = e.type === "message.received" ? "user" : e.type === "agent.message" ? "assistant" : undefined;
      if (!role) continue;
      const last = out.at(-1);
      if (last && last.role === role) last.content = `${last.content as string}\n\n${t}`;
      else out.push({ role, content: t });
    }
    let trimmed = out.slice(-HISTORY_MESSAGES);
    while (trimmed.length > 1 && trimmed.reduce((n, m) => n + (m.content as string).length, 0) > HISTORY_CHARS) trimmed = trimmed.slice(1);
    // The history must start with a user turn and, since `task` is the next user message, end with an assistant one.
    while (trimmed.length && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
    if (trimmed.length && trimmed.at(-1)!.role === "user") trimmed = trimmed.slice(0, -1);
    return trimmed;
  }

  // ---- reads ---------------------------------------------------------------------------------------

  private get(id: string): LiveSession {
    const s = this.sessions.get(id);
    if (!s) throw new ChatError(404, `no session "${id}"`);
    return s;
  }

  events(id: string, after = 0): SessionEvent[] {
    return this.get(id).events.filter((e) => e.seq > after);
  }

  thread(id: string): { sessionId: string; messages: SessionThreadMessage[] } {
    return { sessionId: id, messages: projectThread(this.get(id).events) };
  }

  /** Backlog after `after`, then live frames; returns the unsubscribe. */
  subscribe(id: string, after: number, send: (f: Frame) => void): () => void {
    const s = this.get(id);
    for (const e of s.events) if (e.seq > after) send({ kind: "event", event: e });
    s.subscribers.add(send);
    return () => s.subscribers.delete(send);
  }

  /** Sidebar rows (registry.sessions), newest first. */
  list(): Session[] {
    return [...this.sessions.values()]
      .filter((s) => !s.incognito)
      .map((s) => {
        const first = s.events.find((e) => e.type === "message.received");
        const p = first?.payload;
        const firstText = p && typeof p === "object" && "text" in p ? text(p.text) : undefined;
        const last = s.events.at(-1);
        const title = s.title ?? (firstText ?? "New thread").replace(/\s+/g, " ").slice(0, 48);
        return {
          id: s.id,
          title,
          href: "/",
          agentId: s.agentId,
          messages: s.events.filter((e) => e.type === "message.received" || e.type === "agent.message").length,
          updated: ago(last?.ts ?? s.createdAt, this.now()),
          status: "idle" as const,
          ts: Date.parse(last?.ts ?? s.createdAt), // sort key; stripped below
        };
      })
      .sort((a, b) => b.ts - a.ts)
      .map(({ ts, ...row }) => row);
  }

  /** Interventions the ledger holds from the event start on (what judges will count). */
  interventions(): {
    eventStart: string;
    count: number;
    by_category: Record<string, number>; // missing category on old lines counts as "uncategorized"
    steering: number; // the headline autonomy number (T17)
    entries: InterventionEntry[];
    /** The other side of the ledger: calls the agents made on their own (operator-run entries are human, left out). */
    decisions: { count: number; by_agent: Record<string, number>; entries: Array<Pick<DecisionEntry, "ts" | "agent" | "topic" | "decision" | "rationale">> };
  } {
    const entries = ledgerRead(this.ledgerFile).filter((e): e is InterventionEntry => e.kind === "intervention" && Date.parse(e.ts) >= this.eventStart);
    const by_category = entries.reduce<Record<string, number>>((a, e) => {
      const k = e.category ?? "uncategorized";
      return ((a[k] = (a[k] ?? 0) + 1), a);
    }, {});
    return {
      eventStart: new Date(this.eventStart).toISOString(),
      count: entries.length,
      by_category,
      steering: by_category["steering"] ?? 0,
      entries: entries.slice(-50),
      decisions: this.agentDecisions(),
    };
  }

  private agentDecisions() {
    const all = ledgerRead(this.ledgerFile).filter((e): e is DecisionEntry =>
      e.kind === "decision" && e.agent !== "operator" && Date.parse(e.ts) >= this.eventStart);
    const by_agent = all.reduce<Record<string, number>>((a, e) => ((a[e.agent] = (a[e.agent] ?? 0) + 1), a), {});
    return {
      count: all.length,
      by_agent,
      entries: all.slice(-50).map(({ ts, agent, topic, decision, rationale }) => ({ ts, agent, topic, decision, rationale })),
    };
  }
}

/**
 * The chat window shows text exactly as typed, and models use markdown anyway, so strip it here (a mechanical
 * job for code, not the prompt): emphasis markers, heading hashes, backticks, "* " bullets, fences, links.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    .trim();
}

/** The sidebar's short relative time: "now", "5m", "3h", "2d". */
export function ago(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Same shape as the runner's run-id prefix (local time), so run ids still sort chronologically. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function finalText(result: { status: string; output: unknown; error?: string }): string {
  if (result.status === "done" && typeof result.output === "string" && result.output.trim()) return result.output;
  if (result.status === "done") return "I finished without anything to say.";
  const why: Record<string, string> = {
    budget_exceeded: "I hit my spend limit for this turn",
    max_turns: "I ran out of steps for this turn",
    killed: "the studio kill switch is on",
    stuck: "I got stuck repeating a failing call",
    error: "something went wrong",
  };
  return `I couldn't finish that: ${why[result.status] ?? result.status}${result.error ? ` (${result.error.split("\n")[0].slice(0, 200)})` : ""}.`;
}
