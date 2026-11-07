// Story-only fixtures and decorators for the chat stories (ANY-12 M3). Imported only
// by the *.stories.tsx files in this folder — never from production code — so nothing
// here ships. It provides:
//   - ChatScreen: the production thread mounted exactly as routes/home.tsx mounts it
//     (provider stack and all) on a sized stage — the composed-screen stories' subject.
//     No live agent: stories run the scripted mock adapter on the harness's seeded
//     stores with the pinned clock.
//   - EXISTING_THREAD: a short canned history for "existing thread" states.
//   - failNextAssistantRun: a seam that makes the scripted mock adapter fail once,
//     for the error-display state; the caller restores the adapter afterwards.

import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { mockAssistant } from "@/lib/mock/chat";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabsProvider } from "@/components/shell/tabs";
import { AssistantThread } from "./assistant-thread";

/** A short canned history — plain text only; tool-result cards are another card's scope. */
export const EXISTING_THREAD: ThreadMessageLike[] = [
  { role: "user", content: "Set up a baseline eval harness for the 135M model." },
  { role: "assistant", content: "On it — I'll draft the harness, wire the held-out split, and run the baseline tonight." },
];

/**
 * The composed chat screen: AssistantThread inside the shell's provider stack, the way
 * the home route mounts it. The thread needs a sized stage, hence the h-dvh wrapper.
 */
export function ChatScreen({ sessionId = "story-thread", initialMessages = [], initialAgentIndex = 0 }: {
  sessionId?: string; initialMessages?: readonly ThreadMessageLike[]; initialAgentIndex?: number;
}) {
  const [agentIndex, setAgentIndex] = useState(initialAgentIndex);
  return (
    <TooltipProvider>
      <SidebarProvider>
        <TabsProvider>
          <div className="h-dvh w-full overflow-hidden">
            <AssistantThread
              sessionId={sessionId}
              initialMessages={initialMessages}
              agentIndex={agentIndex}
              onAgentChange={setAgentIndex}
              onBackToDana={() => setAgentIndex(0)}
            />
          </div>
        </TabsProvider>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * Makes the next assistant run fail with `message` — the mock adapter's `run` is swapped
 * for one that throws, which the runtime surfaces through MessagePrimitive.Error. Returns
 * the undo; call it in a finally so no other story inherits the failing adapter.
 */
export function failNextAssistantRun(message: string): () => void {
  const original = mockAssistant.run;
  // The run always fails before streaming anything, so the generator has no yield.
  // eslint-disable-next-line require-yield -- the failure is the whole stream
  mockAssistant.run = (async function* () {
    throw new Error(message);
  }) as unknown as typeof mockAssistant.run;
  return () => { mockAssistant.run = original; };
}
