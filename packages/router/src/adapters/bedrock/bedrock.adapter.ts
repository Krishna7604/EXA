// Amazon Bedrock ConverseStream over plain fetch: authenticates with a bearer API key or SigV4,
// then turns the event-stream frames into ModelChunks.
import type { FinishReason, ModelChunk, ModelRequest, Tokens } from "@exa/protocol";
import type { FetchFn } from "../../models/adapter.model.ts";
import { httpError, parseArgs } from "../adapter-common.ts";
import { toConverse } from "./converse.ts";
import { type EsMessage, EventStreamDecoder } from "./event-stream.ts";
import { type AwsCredentials, signV4 } from "./sigv4.ts";

// ---------- constants ----------
const STOP: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  content_filtered: "content-filter",
  guardrail_intervened: "content-filter",
};

const MAX_ERROR_MESSAGE_CHARS = 800;
const STATUS_THROTTLED = 429;
const STATUS_UNAVAILABLE = 503;
const STATUS_BAD_REQUEST = 400;
const STATUS_SERVER_ERROR = 500;

const UTF8 = new TextDecoder();

// ---------- types ----------
export interface BedrockOpts {
  model: string;
  region: string;
  key?: string;
  aws?: AwsCredentials;
  fetch?: FetchFn;
  signal: AbortSignal;
  baseURL?: string;
  now?: Date;
}

interface PendingTool {
  id: string;
  name: string;
  json: string;
}

/** What the stream has told us so far; emitted as tool calls + finish at the end. */
interface StreamState {
  tools: Map<number, PendingTool>;
  usage: Tokens;
  finish: FinishReason;
}

// ---------- stream ----------
export async function* streamBedrock(
  req: ModelRequest,
  opts: BedrockOpts,
): AsyncGenerator<ModelChunk> {
  const url = converseStreamUrl(opts);
  const body = JSON.stringify(toConverse(req, opts.model));
  const headers = requestHeaders(url, body, opts);
  const f = opts.fetch ?? fetch;
  const res = await f(url.toString(), { method: "POST", headers, body, signal: opts.signal });
  if (!res.ok || !res.body) throw await httpError(res, "bedrock");
  yield { type: "start", model: opts.model, provider: "bedrock" };

  const state: StreamState = {
    tools: new Map(),
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    finish: "stop",
  };
  const completed = yield* readFrames(res.body, state);
  if (!completed) return;
  yield* finalChunks(state);
}

// ---------- request ----------
function converseStreamUrl(opts: BedrockOpts): URL {
  const defaultBase = `https://bedrock-runtime.${opts.region}.amazonaws.com`;
  const base = (opts.baseURL ?? defaultBase).replace("{region}", opts.region);
  return new URL(`${base}/model/${encodeURIComponent(opts.model)}/converse-stream`);
}

function requestHeaders(url: URL, body: string, opts: BedrockOpts): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
  };
  if (opts.key) {
    headers.Authorization = `Bearer ${opts.key}`;
    return headers;
  }
  if (!opts.aws) throw new Error("bedrock: no credentials");
  return signV4({
    method: "POST",
    url,
    headers,
    body,
    region: opts.region,
    service: "bedrock",
    creds: opts.aws,
    now: opts.now,
  });
}

// ---------- response ----------
/** Yields deltas until the body ends (returns true) or an exception frame arrives (false). */
async function* readFrames(
  body: ReadableStream<Uint8Array>,
  state: StreamState,
): AsyncGenerator<ModelChunk, boolean> {
  const decoder = new EventStreamDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return true;
      for (const msg of decoder.push(value)) {
        if (isErrorFrame(msg)) {
          yield errorChunk(msg);
          return false;
        }
        const parsed = parsePayload(msg);
        if (!parsed) continue;
        yield* applyEvent(state, msg.headers[":event-type"], parsed.data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Bedrock event payloads are untyped JSON
function* applyEvent(state: StreamState, event: string, data: any): Generator<ModelChunk> {
  switch (event) {
    case "contentBlockStart": {
      const tu = data.start?.toolUse;
      if (tu)
        state.tools.set(data.contentBlockIndex ?? 0, { id: tu.toolUseId, name: tu.name, json: "" });
      break;
    }
    case "contentBlockDelta":
      yield* applyDelta(state, data);
      break;
    case "messageStop":
      state.finish = STOP[data.stopReason] ?? "stop";
      break;
    case "metadata": {
      const u = data.usage ?? {};
      state.usage.cacheRead = u.cacheReadInputTokens ?? 0;
      state.usage.cacheWrite = u.cacheWriteInputTokens ?? 0;
      state.usage.input = u.inputTokens ?? 0;
      state.usage.output = u.outputTokens ?? 0;
      break;
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Bedrock event payloads are untyped JSON
function* applyDelta(state: StreamState, data: any): Generator<ModelChunk> {
  const d = data.delta ?? {};
  if (typeof d.text === "string" && d.text) {
    yield { type: "text-delta", text: d.text };
    return;
  }
  if (d.toolUse && typeof d.toolUse.input === "string") {
    const t = state.tools.get(data.contentBlockIndex ?? 0);
    if (t) t.json += d.toolUse.input;
    return;
  }
  if (d.reasoningContent?.text) yield { type: "reasoning-delta", text: d.reasoningContent.text };
}

function* finalChunks(state: StreamState): Generator<ModelChunk> {
  for (const [, t] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool-call", callId: t.id, name: t.name, input: parseArgs(t.json) };
  }
  const reason = state.tools.size ? "tool-calls" : state.finish;
  yield { type: "finish", reason, usage: state.usage };
}

// ---------- helpers ----------
function isErrorFrame(msg: EsMessage): boolean {
  const type = msg.headers[":message-type"];
  return type === "exception" || type === "error";
}

/** null when the payload isn't JSON (such frames are skipped). */
// biome-ignore lint/suspicious/noExplicitAny: Bedrock event payloads are untyped JSON
function parsePayload(msg: EsMessage): { data: any } | null {
  try {
    return { data: JSON.parse(UTF8.decode(msg.payload)) };
  } catch {
    return null;
  }
}

function errorChunk(msg: EsMessage): ModelChunk {
  const kind = msg.headers[":exception-type"] ?? msg.headers[":error-code"] ?? "error";
  let detail = "";
  try {
    detail = JSON.parse(UTF8.decode(msg.payload)).message ?? "";
  } catch {
    // Non-JSON exception payload: the exception type alone is still a useful message.
  }
  const status = statusForException(kind);
  return {
    type: "error",
    message: `bedrock: ${kind}: ${detail}`.slice(0, MAX_ERROR_MESSAGE_CHARS),
    status,
    retryable: status === STATUS_THROTTLED || status >= STATUS_SERVER_ERROR,
  };
}

function statusForException(kind: string): number {
  if (/throttl/i.test(kind)) return STATUS_THROTTLED;
  if (/unavailable|internal|overload/i.test(kind)) return STATUS_UNAVAILABLE;
  if (/validation/i.test(kind)) return STATUS_BAD_REQUEST;
  return STATUS_SERVER_ERROR;
}
