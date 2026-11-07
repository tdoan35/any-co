// Mock-only guard for the storybook harness (ANY-8 M1): HTTP and SSE are hard-failed,
// loudly, before any socket is opened — no real server process is needed to detect a
// story (or its component) reaching for the network instead of the seeded mock world.

import { httpMode } from "@/lib/api";

export type NetworkKind = "fetch" | "sse";

export interface NetworkAttempt {
  kind: NetworkKind;
  url: string;
}

const attempts: NetworkAttempt[] = [];
let installed = false;

/** A network call the storybook preview iframe is not allowed to make. */
export class NetworkGuardError extends Error {
  constructor(kind: NetworkKind, url: string) {
    super(`[storybook] unexpected ${kind === "sse" ? "SSE" : "HTTP"} call blocked: ${url} — stories run mock-only; seed the harness instead`);
    this.name = "NetworkGuardError";
  }
}

/**
 * Swap fetch/EventSource for sentinels that record the attempt and throw. Idempotent, and
 * permanent for the preview iframe's lifetime — that is the point. Also pins the run to
 * mock mode: a storybook session with VITE_API_MODE=http is a configuration mistake.
 */
export function installNetworkGuard() {
  if (installed) return;
  if (httpMode) throw new Error("[storybook] the harness is mock-only: unset VITE_API_MODE=http");
  installed = true;
  window.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    attempts.push({ kind: "fetch", url });
    throw new NetworkGuardError("fetch", url);
  }) as typeof window.fetch;
  const guardedEventSource = function (url: string | URL) {
    const href = typeof url === "string" ? url : url.href;
    attempts.push({ kind: "sse", url: href });
    throw new NetworkGuardError("sse", href);
  } as unknown as typeof EventSource;
  window.EventSource = guardedEventSource;
}

export const networkAttempts = (): readonly NetworkAttempt[] => attempts;

export function resetNetworkGuard() {
  attempts.length = 0;
}
