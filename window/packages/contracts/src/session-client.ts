// ANY-65 S12a — the platform-neutral session client: post, follow, resume.
// RUNTIME §13 "post, then follow the stream": POST the message, then hold the
// SSE stream open, resuming with ?after=<last seq> whenever the connection drops.
// The transport is injected (`fetch`), so the same client runs in the browser,
// node and react-native without platform branches.
import {
    CreateSessionResponseSchema,
    PostMessageResponseSchema,
    parseFrame,
    SessionFrameError,
    type CreateSessionRequest,
    type CreateSessionResponse,
    type PostMessageRequest,
    type PostMessageResponse,
    type SessionDelta,
    type SessionEvent,
} from "./sessions";

/** The slice of `fetch` this client needs; pass the global `fetch` or a test double. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const withBase = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `sleep` that resolves early when the signal aborts. */
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(done, ms);
        const onAbort = (): void => done();
        function done(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });

// ----------------------------------------------------------------------------------
// createSession
// ----------------------------------------------------------------------------------

export async function createSession(fetchLike: FetchLike, base: string, req: CreateSessionRequest): Promise<CreateSessionResponse> {
    const res = await fetchLike(withBase(base, "/api/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`createSession failed: HTTP ${res.status}`);
    return CreateSessionResponseSchema.parse(await res.json());
}

// ----------------------------------------------------------------------------------
// postMessage — at most 3 attempts, same clientMessageId every time
// ----------------------------------------------------------------------------------

const POST_ATTEMPTS = 3;
/** Backoff between retries, by attempt number: 0.5 s then 1 s. */
const POST_BACKOFF_MS = [500, 1000];

/** PostMessageRequest with the id optional — the client generates it when absent. */
export type PostMessageInput = Omit<PostMessageRequest, "clientMessageId"> & { clientMessageId?: string };

export async function postMessage(fetchLike: FetchLike, base: string, sessionId: string, req: PostMessageInput): Promise<PostMessageResponse> {
    // One id for the logical message: every retry carries the same one, so the
    // server can deduplicate instead of double-appending.
    const body = JSON.stringify({ ...req, clientMessageId: req.clientMessageId ?? crypto.randomUUID() });
    for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
            res = await fetchLike(withBase(base, `/api/sessions/${sessionId}/messages`), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
            });
        } catch (err) {
            if (attempt >= POST_ATTEMPTS) throw err;
            await sleep(POST_BACKOFF_MS[attempt - 1]!);
            continue;
        }
        if (res.ok) return PostMessageResponseSchema.parse(await res.json());
        // A 4xx is a final answer about this message — a retry would get the
        // same verdict. A 5xx never produced one: worth another attempt.
        if (res.status >= 500 && attempt < POST_ATTEMPTS) {
            await sleep(POST_BACKOFF_MS[attempt - 1]!);
            continue;
        }
        throw new Error(`postMessage failed: HTTP ${res.status}`);
    }
}

// ----------------------------------------------------------------------------------
// followSession — the never-ending stream
// ----------------------------------------------------------------------------------

export interface FollowSessionOptions {
    /** Resume from this seq on the first connect; later connects resume from the last seq seen. */
    after?: number;
    onEvent: (event: SessionEvent) => void;
    onDelta: (delta: SessionDelta) => void;
    /** Aborting stops the reconnect loop and resolves the returned promise. */
    signal?: AbortSignal;
}

/** Reconnect backoff after dropped connections, capped at its last entry. */
const FOLLOW_BACKOFF_MS = [500, 1000, 2000, 4000, 10_000];

const followBackoff = (step: number): number => FOLLOW_BACKOFF_MS[Math.min(step, FOLLOW_BACKOFF_MS.length - 1)]!;

export async function followSession(fetchLike: FetchLike, base: string, sessionId: string, opts: FollowSessionOptions): Promise<void> {
    const { onEvent, onDelta, signal } = opts;
    const aborted = (): boolean => signal?.aborted ?? false;

    // The resume cursor. `after` seeds the first connect; every delivered event
    // frame's id (== its seq, see S3) moves it forward. Deltas carry no seq.
    let lastSeq: number | undefined = opts.after;
    let backoffStep = 0;

    while (!aborted()) {
        const url = `${withBase(base, `/api/sessions/${sessionId}/stream`)}?after=${lastSeq ?? 0}`;
        let res: Response;
        try {
            res = await fetchLike(url, { signal });
        } catch {
            if (aborted()) return;
            await abortableSleep(followBackoff(backoffStep++), signal);
            continue;
        }
        if (!res.ok || !res.body) {
            if (aborted()) return;
            await abortableSleep(followBackoff(backoffStep++), signal);
            continue;
        }

        backoffStep = 0; // connected: whatever drops next waits 0.5 s again

        const end = await consumeStream(res.body, { onEvent, onDelta, signal }, (seq: number) => {
            lastSeq = seq;
        });
        void end;
        if (aborted()) return;

        // Dropped (stream closed, broke, or a malformed frame): back off, resume
        // from the last seq seen — the server replays from there, and frames the
        // connection already delivered are dropped on arrival.
        await abortableSleep(followBackoff(backoffStep++), signal);
    }
}

/**
 * Reads the SSE body to the end, delivering whole frames only — bytes are
 * buffered until their closing blank line, so a frame split across chunks
 * parses once. Resolves when the stream ends or the signal aborts (the pending
 * read is cancelled); throws on stream errors other than malformed frames.
 * Returns why it ended (informational; both ends mean "reconnect").
 */
async function consumeStream(
    body: ReadableStream<Uint8Array>,
    handlers: Pick<FollowSessionOptions, "onEvent" | "onDelta" | "signal">,
    onSeq: (seq: number) => void,
): Promise<"closed" | "malformed-frame"> {
    const reader = body.getReader();
    const onAbort = (): void => {
        void reader.cancel().catch(() => {});
    };
    handlers.signal?.addEventListener("abort", onAbort, { once: true });

    const decoder = new TextDecoder();
    let buffer = "";
    let deliveredUpTo = Number.NEGATIVE_INFINITY;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return "closed";
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const frameEnd = buffer.indexOf("\n\n");
                if (frameEnd < 0) break;
                const block = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);
                const frame = parseFrame(block);
                if (frame.event === "event") {
                    if (frame.id <= deliveredUpTo) continue; // replayed or duplicated seq
                    deliveredUpTo = frame.id;
                    onSeq(frame.id);
                    handlers.onEvent(frame.data);
                } else if (frame.event === "delta") {
                    handlers.onDelta(frame.data);
                } // ping: keep-alive, nothing to deliver
            }
        }
    } catch (err) {
        if (err instanceof SessionFrameError) return "malformed-frame";
        throw err;
    } finally {
        handlers.signal?.removeEventListener("abort", onAbort);
    }
}
