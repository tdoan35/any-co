import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { AssistantThread } from "@/components/chat/assistant-thread";
import { SESSION_PARAM, knownEmpty, loadThread, newSessionId, threadPath } from "@/lib/chat/session";
import { httpMode } from "@/lib/api";
import { chatAgents, useRegistry } from "@/lib/registry";

/**
 * A thread per session (IA-5): `/?session=<id>` names it, so a reload or a title-bar tab comes back to
 * the same thread. A bare `/` — New thread, a new tab, Back to Dana — starts a fresh session, even
 * when you're already on `/`.
 */
export function HomePage() {
  useRegistry();
  // Live mode chats with the Studio Head only; without a `head` agent spec there is no one to talk to yet.
  if (httpMode && chatAgents().length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">No Studio Head yet</h1>
          <p className="text-sm text-muted-foreground">Chat talks to the agent whose spec has <code>dept: "head"</code> in <code>agents/</code>. Add one and restart the adapter.</p>
        </div>
      </div>
    );
  }
  return <ChatHome />;
}

function ChatHome() {
  // The selected agent lives here so it survives starting a new thread ("Back to Dana" starts one).
  const [agentIndex, setAgentIndex] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const urlSession = new URLSearchParams(location.search).get(SESSION_PARAM);
  // location.key changes on every navigation, so each visit to a bare "/" mints its own id.
  const fresh = useMemo(() => newSessionId(), [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessionId = urlSession ?? fresh;
  useEffect(() => {
    if (!urlSession) navigate(threadPath(sessionId), { replace: true });
  }, [urlSession, sessionId, navigate]);
  return (
    <ThreadLoader
      key={sessionId}
      sessionId={sessionId}
      agentIndex={agentIndex}
      onAgentChange={setAgentIndex}
      onBackToDana={() => { setAgentIndex(0); navigate("/"); }}
    />
  );
}

/** Mounts the thread once its history is in: the runtime starts from it (http mode; mock threads start empty). */
function ThreadLoader({ sessionId, ...thread }: Omit<React.ComponentProps<typeof AssistantThread>, "initialMessages">) {
  const [initial, setInitial] = useState<readonly ThreadMessageLike[] | undefined>(() => (knownEmpty(sessionId) ? [] : undefined));
  useEffect(() => {
    if (initial) return;
    let live = true;
    loadThread(sessionId)
      .then((messages) => { if (live) setInitial(messages); })
      .catch((err) => {
        console.warn("[chat] history failed to load; starting the thread empty", err);
        if (live) setInitial([]);
      });
    return () => { live = false; };
  }, [sessionId, initial]);
  if (!initial) return null;
  return <AssistantThread sessionId={sessionId} initialMessages={initial} {...thread} />;
}
