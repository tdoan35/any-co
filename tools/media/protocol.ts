// Minimal client for the qa/ file protocol (docs/contracts/controls.md), local to tools/media.
// DUPLICATION NOTE: tools/qa (another seat, another branch) builds the full QA driver over the same
// protocol. This copy is deliberately small (ready, send/ack, events tail); consolidate into one
// shared module once both land.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Ack { id: number; ok: boolean; error?: string; [k: string]: unknown }
export interface GameEvent { schema_version: number; tick: number; event: string; data: Record<string, unknown> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // missing or (despite atomic writes) unreadable: poll again
  }
}

export class QaClient {
  readonly qaDir: string;
  private nextId = 1;
  private eventsOffset = 0;
  private partial = "";
  constructor(gameDir: string, private pollMs = 5, private alive: () => boolean = () => true) {
    this.qaDir = path.join(gameDir, "qa");
  }

  /** Wait for the startup ack `{id: 0, ok: true, ready: true}`. */
  async ready(deadline: number): Promise<void> {
    const ackFile = path.join(this.qaDir, "ack.json");
    for (;;) {
      const a = readJson(ackFile);
      if (a && a.id === 0 && a.ok === true && a.ready === true) return;
      this.check(deadline, "the game's ready ack (qa/ack.json id 0)");
      await sleep(this.pollMs);
    }
  }

  /** Write a command atomically and wait for its ack. A not-ok ack throws with the game's error. */
  async send(cmd: Record<string, unknown>, deadline: number): Promise<Ack> {
    const id = this.nextId++;
    const file = path.join(this.qaDir, "control.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ id, ...cmd }));
    renameSync(`${file}.tmp`, file);
    const ackFile = path.join(this.qaDir, "ack.json");
    for (;;) {
      const a = readJson(ackFile) as Ack | null;
      if (a && a.id === id) {
        if (!a.ok) throw new Error(`game refused ${String(cmd.cmd)} (id ${id}): ${a.error ?? "no error text"}`);
        return a;
      }
      this.check(deadline, `the ack for ${String(cmd.cmd)} (id ${id})`);
      await sleep(this.pollMs);
    }
  }

  /** New complete lines from qa/events.jsonl since the last call. */
  newEvents(): GameEvent[] {
    const file = path.join(this.qaDir, "events.jsonl");
    if (!existsSync(file)) return [];
    const buf = readFileSync(file);
    if (buf.length < this.eventsOffset) this.eventsOffset = 0; // truncated (restart)
    const text = this.partial + buf.subarray(this.eventsOffset).toString("utf8");
    this.eventsOffset = buf.length;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const out: GameEvent[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // a malformed line is the game's bug; skip it rather than stop capture
      }
    }
    return out;
  }

  private check(deadline: number, waitingFor: string) {
    if (!this.alive()) throw new Error(`game exited while waiting for ${waitingFor}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${waitingFor}`);
  }
}
