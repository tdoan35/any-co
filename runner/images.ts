// Wire-format expansion for image blocks. Inside the runner, images are refs to
// content-addressed copies in runs/<id>/images/; right before a provider call the refs are
// expanded to base64 so the transcript (and any resume) never depends on base64 blobs.
import { readFileSync } from "node:fs";
import type { Block, ImageBlock, Message } from "./types.ts";

function wireImage(b: ImageBlock): ImageBlock {
  if (b.source.type !== "ref") return b;
  let data: string;
  try {
    data = readFileSync(b.source.path).toString("base64");
  } catch (e) {
    throw new Error(`image copy is unreadable (${b.source.path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  return { type: "image", source: { type: "base64", media_type: b.source.media_type, data } };
}

function wireBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.type === "image" ? wireImage(b) : b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.map((c) => (c.type === "image" ? wireImage(c) : c)) } : b,
  );
}

/** Expand image refs to base64 for sending. Throws on a missing copy rather than guessing. */
export function wireMessages(messages: Message[]): Message[] {
  return messages.map((m) => (typeof m.content === "string" ? m : { role: m.role, content: wireBlocks(m.content) }));
}
