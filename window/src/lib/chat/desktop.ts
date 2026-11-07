import { useEffect, useState } from "react";
import { httpMode } from "@/lib/api";
import { apiBase } from "@/lib/api/http";
import { onSessionDesktop, onStreamConnected, type SessionDesktop } from "./events";

const idle: SessionDesktop = { url: null, runId: null, screenshotArtifactId: null, replay: false };

/** Event-driven desktop state; snapshots restore reloads and reconnects, never overwrite newer events. */
export function useSessionDesktop(sessionId: string): SessionDesktop {
  const [state, setState] = useState<{ sessionId: string; desktop: SessionDesktop }>({ sessionId, desktop: idle });
  // A new session starts idle; reset during render so the previous session's desktop never paints.
  if (state.sessionId !== sessionId) setState({ sessionId, desktop: idle });
  useEffect(() => {
    if (!httpMode) return;
    let stopped = false;
    let revision = 0;
    let requestId = 0;
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const expectedRevision = revision;
      const expectedRequest = ++requestId;
      void fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Session desktop unavailable (${response.status})`);
          return response.json() as Promise<{ desktop?: SessionDesktop }>;
        })
        .then(({ desktop }) => {
          if (!stopped && revision === expectedRevision && requestId === expectedRequest) {
            setState({ sessionId, desktop: desktop ?? idle });
          }
        })
        .catch((error: unknown) => {
          if (!stopped && !controller.signal.aborted) console.warn("[chat] desktop refresh failed", error);
        });
    };
    const unsubscribe = onSessionDesktop((event) => {
      if (event.sessionId !== sessionId) return;
      revision++;
      setState({ sessionId, desktop: { url: event.url, runId: event.runId, screenshotArtifactId: event.screenshotArtifactId ?? null, replay: event.replay ?? false } });
    });
    const disconnect = onStreamConnected(refresh);
    refresh();
    return () => { stopped = true; pending?.abort(); unsubscribe(); disconnect(); };
  }, [sessionId]);
  return state.sessionId === sessionId ? state.desktop : idle;
}
