// The chat adapter, on the session protocol (RUNTIME §13): the turn is one
// `sessionTurn` — post the message, then follow the stream, relaying the
// provisional text as it grows and the projected assistant message once the
// turn's `agent.message` lands. The transport is `api`, so the same adapter
// serves the real server and the in-memory mock; the human-tool flow is
// unchanged: a card's addResult stamps {decision} on its part and starts the
// next run, whose turn the server decides from the log.
import type { ChatModelAdapter } from "@assistant-ui/react";
import { chatAgentContext, sessionTurn } from "./session-stream";
import { markSent, toRuntimeParts } from "./session";

/** The turn's text: the last user message's words (the server has the history). */
type RunMessage = { role: string; content: readonly { type: string; text?: string }[] };
const turnText = (messages: readonly RunMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    return message.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(" ").trim();
  }
  return "";
};

export function httpAssistant(sessionId: string, opts: { incognito?: boolean } = {}): ChatModelAdapter {
  return {
    async *run(options) {
      // A turn went out on this thread: its history lives on the server now.
      markSent(sessionId);
      const messages = options.messages as readonly RunMessage[];
      const last = messages.at(-1);
      // A run whose last message is the assistant's is the human-tool
      // continuation: the card stamped {decision} on its part, and the stamp
      // rides the post's attachments (free-form per the contract) for the
      // mock brain; the server's own decision path is the proposals endpoint.
      const continuation = last?.role === "assistant" ? { role: last.role, content: last.content } : undefined;
      const turn = sessionTurn(sessionId, {
        text: turnText(messages),
        attachments: continuation ? [continuation] : undefined,
        agentId: chatAgentContext.id,
        incognito: opts.incognito,
        signal: options.abortSignal,
      });
      for await (const step of turn) {
        yield { content: toRuntimeParts(step.content) } as never;
      }
    }
  };
}
