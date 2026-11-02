// Newline-delimited JSON streaming response for model output. A mid-stream failure becomes a
// final `{type:"error"}` line, since the 200 status has already been sent.
import { type ModelError, ndjsonLine } from "@exa/protocol";

// ---------- constants ----------
const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

// ---------- types ----------
/** A stream whose first item has already been pulled (so its errors became HTTP errors). */
export interface PrefetchedStream {
  first: IteratorResult<unknown>;
  rest: AsyncIterable<unknown>;
}

// ---------- ndjson ----------
/** Streams chunks as NDJSON; cancelling the response aborts the upstream request. */
export function ndjsonResponse(opened: PrefetchedStream, ac: AbortController): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!opened.first.done) controller.enqueue(ndjsonLine(opened.first.value));
        for await (const chunk of opened.rest) controller.enqueue(ndjsonLine(chunk));
      } catch (e) {
        controller.enqueue(ndjsonLine(errorLine(e)));
      } finally {
        controller.close();
      }
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}

// ---------- helpers ----------
function errorLine(e: unknown) {
  const err = e as ModelError;
  return {
    type: "error",
    message: err.message ?? String(e),
    status: err.status ?? 0,
    retryable: err.retryable ?? false,
  };
}
