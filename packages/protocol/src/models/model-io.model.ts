// Provider-neutral model I/O. The gateway speaks this both in-process (server loop)
// and over HTTP (client loop → POST /v1/model/stream, NDJSON of ModelChunk).

import type { FinishReason, Tokens } from "./messages.model.ts";

// ---------- types ----------
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "tool-result"; callId: string; name: string; output: string; isError?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export type Tier = "fast" | "balanced" | "strong";

export interface ModelRequest {
  /** "exa", "exa/fast", or "provider/model-id". */
  model: string;
  system: string;
  messages: ModelMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Hint for the exa orchestrator (utility agents ask for fast). */
  tier?: Tier;
  /** Provider pass-through options (reasoning effort etc). */
  options?: Record<string, unknown>;
  /** Attribution only; the gateway never trusts it for auth. */
  sessionId?: string;
}

export type ModelChunk =
  | { type: "start"; model: string; provider: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "finish"; reason: FinishReason; usage: Partial<Tokens>; cost?: number }
  | { type: "error"; message: string; status?: number; retryable?: boolean };

// ---------- errors ----------
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ModelError";
  }
}
