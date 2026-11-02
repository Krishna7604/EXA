// Streams one model reply into an assistant message's parts, emitting live deltas, and
// retries transient failures as long as nothing has been produced yet.

import {
  type FinishReason,
  isRetryableStatus,
  type MessageInfo,
  type ModelChunk,
  ModelError,
  type ModelRequest,
  newId,
  type Part,
  type ReasoningPart,
  type TextPart,
  type Tokens,
  type ToolPart,
} from "@exa/protocol";
import { newPart } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- constants ----------
const RETRY_DETAIL_MAX_CHARS = 200;
const UNKNOWN_STATUS = 0;

// ---------- types ----------
export interface StreamedReply {
  /** Tool calls in the order the model made them (also present in the message parts). */
  calls: ToolPart[];
  reason: FinishReason | null;
  usage: Partial<Tokens>;
  cost?: number;
  /** `provider/model` reported by the router, when it says. */
  modelUsed?: string;
  error: ModelError | null;
}

/** The assistant message being written; streamed parts are appended to `parts`. */
export interface ReplyTarget {
  info: MessageInfo;
  parts: Part[];
}

// ---------- model stream ----------
export async function streamReply(
  rt: LoopRuntime,
  req: ModelRequest,
  target: ReplyTarget,
  signal: AbortSignal,
): Promise<StreamedReply> {
  const reply: StreamedReply = { calls: [], reason: null, usage: {}, error: null };
  for (let attempt = 0; ; attempt++) {
    const collector = new ChunkCollector(rt, target, reply);
    try {
      await collector.consume(req, signal);
      return reply;
    } catch (e) {
      const err = toModelError(e);
      if (signal.aborted) return reply;
      const canRetry = !collector.hasProduced && err.retryable && attempt < rt.cfg.retries;
      if (!canRetry) {
        reply.error = err;
        return reply;
      }
      rt.emit("session.status", target.info.sessionId, {
        status: "retry",
        detail: err.message.slice(0, RETRY_DETAIL_MAX_CHARS),
      });
      await sleep(rt.cfg.retryBaseMs * 2 ** attempt, signal);
    }
  }
}

// ---------- chunk collector ----------
/** One streaming attempt: turns chunks into parts and records finish/usage on the reply. */
class ChunkCollector {
  hasProduced = false;
  private text: TextPart | null = null;
  private reasoning: ReasoningPart | null = null;

  constructor(
    private readonly rt: LoopRuntime,
    private readonly target: ReplyTarget,
    private readonly reply: StreamedReply,
  ) {}

  async consume(req: ModelRequest, signal: AbortSignal): Promise<void> {
    for await (const chunk of this.rt.deps.model.stream(req, signal)) {
      if (signal.aborted) break;
      this.handle(chunk);
    }
  }

  private handle(chunk: ModelChunk): void {
    switch (chunk.type) {
      case "start":
        this.reply.modelUsed = chunk.provider ? `${chunk.provider}/${chunk.model}` : chunk.model;
        break;
      case "text-delta":
        if (chunk.text) this.appendText(chunk.text);
        break;
      case "reasoning-delta":
        if (chunk.text) this.appendReasoning(chunk.text);
        break;
      case "tool-call":
        this.addToolCall(chunk);
        break;
      case "finish":
        this.reply.reason = chunk.reason;
        this.reply.usage = chunk.usage ?? {};
        this.reply.cost = chunk.cost;
        break;
      case "error":
        throw chunkError(chunk);
    }
  }

  private appendText(delta: string): void {
    this.hasProduced = true;
    this.reasoning = null;
    this.text ??= this.openPart(newPart(this.target.info, "text", { text: "" }));
    this.appendDelta(this.text, delta);
  }

  private appendReasoning(delta: string): void {
    this.hasProduced = true;
    this.text = null;
    this.reasoning ??= this.openPart(newPart(this.target.info, "reasoning", { text: "" }));
    this.appendDelta(this.reasoning, delta);
  }

  private addToolCall(chunk: Extract<ModelChunk, { type: "tool-call" }>): void {
    this.hasProduced = true;
    this.text = null;
    this.reasoning = null;
    const part = newPart(this.target.info, "tool", {
      callId: chunk.callId || newId(),
      tool: chunk.name,
      state: { status: "pending", input: chunk.input },
    });
    this.target.parts.push(part);
    this.reply.calls.push(part);
    this.rt.emit("message.part.updated", part.sessionId, { part });
  }

  private openPart<P extends TextPart | ReasoningPart>(part: P): P {
    this.target.parts.push(part);
    this.rt.emit("message.part.updated", part.sessionId, { part: { ...part } });
    return part;
  }

  private appendDelta(part: TextPart | ReasoningPart, delta: string): void {
    part.text += delta;
    this.rt.emit("message.part.delta", part.sessionId, {
      messageId: part.messageId,
      partId: part.id,
      field: "text",
      delta,
    });
  }
}

// ---------- helpers ----------
function chunkError(chunk: Extract<ModelChunk, { type: "error" }>): ModelError {
  const status = chunk.status ?? UNKNOWN_STATUS;
  return new ModelError(chunk.message, status, chunk.retryable ?? isRetryableStatus(status));
}

/** Anything thrown by a provider becomes a ModelError; unknown failures count as retryable. */
function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const message = (e as Error)?.message ?? String(e);
  const status = (e as { status?: number })?.status ?? UNKNOWN_STATUS;
  return new ModelError(message, status, true);
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
