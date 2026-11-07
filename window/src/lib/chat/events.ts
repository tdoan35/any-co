// `session.message {sessionId, messageId}` from the app stream (routes/root.tsx), handed to the open
// thread so Dana's results message (CHAT-14) lands without a reload.
type SessionMessage = { sessionId: string; messageId: string };

const listeners = new Set<(e: SessionMessage) => void>();

export function publishSessionMessage(e: SessionMessage) {
  for (const listener of listeners) listener(e);
}

export function onSessionMessage(listener: (e: SessionMessage) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type SessionDesktop = {
  url: string | null;
  runId: string | null;
  screenshotArtifactId?: string | null;
  replay?: boolean;
};
type DesktopEvent = SessionDesktop & { sessionId: string };
const desktopListeners = new Set<(e: DesktopEvent) => void>();
const reconnectListeners = new Set<() => void>();

export function publishSessionDesktop(e: DesktopEvent) {
  for (const listener of desktopListeners) listener(e);
}

export function onSessionDesktop(listener: (e: DesktopEvent) => void) {
  desktopListeners.add(listener);
  return () => { desktopListeners.delete(listener); };
}

export function publishStreamConnected() {
  for (const listener of reconnectListeners) listener();
}

export function onStreamConnected(listener: () => void) {
  reconnectListeners.add(listener);
  return () => { reconnectListeners.delete(listener); };
}
