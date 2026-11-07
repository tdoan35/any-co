import type { ChatModelAdapter } from "@assistant-ui/react";
import type { Disposition, ProposalDecision } from "@fabric/contracts";
import { handoff, specialistProposal, teamProposal } from "@fabric/fixtures/chat";
export { IDEA_PROMPT, handoff, specialistProposal, teamProposal } from "@fabric/fixtures/chat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Which agent the UI is currently addressing. Set by the chat screen; read by the scripted adapter. */
export const mockContext = { agent: "Dana" };

let n = 0;
const id = () => `call-${++n}`;

const disposition = (d: Disposition, reason: string) => ({
  type: "tool-call" as const,
  toolCallId: id(),
  toolName: "record_disposition",
  args: { disposition: d, reason },
  argsText: JSON.stringify({ disposition: d, reason }),
  result: { recorded: true },
});

async function* typeOut(prefix: unknown[], text: string) {
  const words = text.split(" ");
  let acc = "";
  for (const w of words) {
    acc += (acc ? " " : "") + w;
    yield { content: [...prefix, { type: "text" as const, text: acc }] } as never;
    await sleep(25);
  }
}

interface Part { type: string; toolName?: string; result?: unknown; args?: unknown }

/**
 * Scripted stand-in for the Mastra agent. A state machine over the thread.
 * After a card decision the UI starts a new run whose last message is the
 * assistant turn carrying the tool result; we branch on that.
 */
export const mockAssistant: ChatModelAdapter = {
  async *run({ messages }) {
    await sleep(300);
    if (mockContext.agent !== "Dana") {
      yield* typeOut([], `${mockContext.agent} here. (Mock reply: direct chats with specialists aren't connected to a backend yet, so this is a placeholder.)`);
      return;
    }
    const prev = messages[messages.length - 1];
    const parts = (prev.role === "assistant" ? prev.content : []) as unknown as Part[];
    const team = parts.find((p) => p.toolName === "propose_team");
    const spec = parts.find((p) => p.toolName === "propose_specialist");
    const decisionOf = (p?: Part) => (p?.result as { decision: ProposalDecision } | undefined)?.decision;

    if (spec && decisionOf(spec)) {
      const d = decisionOf(spec);
      if (d === "approved") {
        const pre = [disposition("delegate_team", "Team is complete; hand off the experiment with a compiled brief.")];
        const text = "Got it, the team is formed and your experiment is handed off. I'll ping you here and by email when there are results.";
        yield* typeOut(pre, text);
        yield {
          content: [
            ...pre,
            { type: "text", text },
            { type: "tool-call", toolCallId: id(), toolName: "handoff_to_team", args: handoff, argsText: JSON.stringify(handoff), result: { ok: true } },
          ],
        } as never;
        return;
      }
      yield* typeOut([], d === "declined" ? "No problem, I'll hand off without a Validator. The Reviewer still checks the work." : "Sure, what would you like to change about the Validator?");
      return;
    }
    if (team && decisionOf(team)) {
      const d = decisionOf(team);
      if (d === "approved") {
        const pre = [disposition("propose_specialist", "A missing capability: independent validation.")];
        const text = "Ok will do — but adding a validator to the team would improve the results. It can check the work independently.";
        yield* typeOut(pre, text);
        yield {
          content: [
            ...pre,
            { type: "text", text },
            { type: "tool-call", toolCallId: id(), toolName: "propose_specialist", args: specialistProposal, argsText: "{}" },
          ],
        } as never;
        return;
      }
      yield* typeOut([], d === "declined" ? "Understood. I won't build the team. Want me to just answer questions about the idea instead?" : "Happy to talk it through. Which part of the team would you change?");
      return;
    }

    const last = prev;
    const text = last.content.map((p) => ("text" in p ? p.text : "")).join(" ").toLowerCase();
    const isIdea = /n-gram|engram|lookup table|experiment|test an idea/.test(text) && text.length > 60;

    if (isIdea) {
      const pre = [disposition("propose_team", "Multi-step research: survey, implement, review. Best handled by a team.")];
      const t = "That's an interesting idea — but I think it would go better if I built a research team for it. It'd cover the survey, the implementation and an independent review.";
      yield* typeOut(pre, t);
      yield {
        content: [
          ...pre,
          { type: "text", text: t },
          { type: "tool-call", toolCallId: id(), toolName: "propose_team", args: teamProposal, argsText: "{}" },
        ],
      } as never;
      return;
    }

    const pre = [disposition("handle_directly", "Conceptual question; no delegation needed.")];
    const reply = /one line/.test(text) && /n-gram/.test(text)
      ? "An n-gram is a run of n consecutive tokens. Counting how often each one follows its context gives a simple lookup-table language model."
      : "I can answer that directly without building a team. (Mock reply: the backend isn't connected yet, so this is a placeholder.)";
    yield* typeOut(pre, reply);
  },
};
