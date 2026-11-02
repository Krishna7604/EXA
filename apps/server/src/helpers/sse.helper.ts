// Server-Sent Events response for one session's live event stream. Resumable: a client passes
// the last seq it saw and gets everything after it, or a resync marker when that's gone.

import type { EventBus } from "@exa/core";
import { type ExaEvent, makeEvent, sseComment, sseEncode } from "@exa/protocol";

// ---------- constants ----------
const HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

// ---------- event stream ----------
export function sessionEventStream(
  bus: EventBus,
  sessionId: string,
  opts: { after?: number; signal: AbortSignal },
): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = pipeEvents(controller, bus, sessionId, opts.after);
      opts.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

// ---------- helpers ----------
/** Subscribes the controller to the bus; returns an idempotent cleanup. */
function pipeEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  bus: EventBus,
  sessionId: string,
  after: number | undefined,
): () => void {
  let closed = false;
  // A failed enqueue means the client went away: tear the subscription down.
  const enqueue = (chunk: Uint8Array) => {
    try {
      controller.enqueue(chunk);
    } catch {
      cleanup();
    }
  };
  const send = (e: ExaEvent) => {
    if (!closed) enqueue(sseEncode(e));
  };

  controller.enqueue(sseComment("connected"));
  if (after !== undefined && after > 0 && bus.oldestSeq(sessionId) > after + 1) {
    const resync = makeEvent("session.resync", sessionId, { fromSeq: after });
    controller.enqueue(sseEncode({ ...resync, seq: 0 }));
  }
  // Replayed events may be sent synchronously inside subscribe(), before setup finishes;
  // cleanup is a no-op until then (a later heartbeat failure tears it down).
  let unsubscribe: (() => void) | null = null;
  unsubscribe = bus.subscribe(sessionId, send, after ?? bus.lastSeq(sessionId));
  const heartbeat = setInterval(() => enqueue(sseComment("hb")), HEARTBEAT_INTERVAL_MS);

  function cleanup(): void {
    if (closed || !unsubscribe) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    try {
      controller.close();
    } catch {
      // Already closed or errored by the runtime; nothing left to release.
    }
  }
  return cleanup;
}
