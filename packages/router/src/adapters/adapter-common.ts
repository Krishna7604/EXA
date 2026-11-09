// Shared by the wire adapters: HTTP error mapping, forgiving tool-argument parsing, and
// flattening tool blocks for requests that carry no tool definitions.

import { isRetryableStatus, ModelError, type ModelMessage } from "@exa/protocol";

// ---------- constants ----------
/** Provider error text kept in a ModelError (it ends up in the chat UI). */
const MAX_ERROR_BODY_CHARS = 800;

// ---------- adapter helpers ----------
export async function httpError(res: Response, label: string): Promise<ModelError> {
  let body = "";
  try {
    body = await res.text();
  } catch {}
  return httpErrorFromBody(res, label, body);
}

/** Same as httpError, for a response whose body was already read. */
export function httpErrorFromBody(res: Response, label: string, body: string): ModelError {
  // never echo request headers / keys; body from providers is safe to surface
  const retryAfter = res.headers.get("retry-after");
  const wait = retryAfter ? ` (retry-after ${retryAfter}s)` : "";
  const msg = `${label} ${res.status}${wait}: ${providerMessage(body)}`;
  return new ModelError(msg, res.status, isRetryableStatus(res.status));
}

/**
 * The human part of a provider error body: `error.message` / `message` from JSON bodies
 * (OpenAI, OpenRouter, Anthropic, Gemini all use one of these), else the trimmed text.
 */
export function providerMessage(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(text);
    const message =
      j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : null);
    if (typeof message === "string" && message) return message.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS);
}

/** Parse tool arguments; tolerate trailing garbage / empty strings from flaky providers. */
export function parseArgs(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // common repair: model emitted two concatenated objects or a trailing comma
    const end = s.lastIndexOf("}");
    if (end > 0) {
      try {
        return JSON.parse(s.slice(0, end + 1).replace(/,\s*([}\]])/g, "$1"));
      } catch {}
    }
    return { __invalid_json: s.slice(0, 2000) };
  }
}

/**
 * Providers reject tool_use/tool_result blocks when the request carries no tool definitions
 * (e.g. the final "summarize, no tools" step). Render them as plain text in that case.
 */
export function flattenToolBlocks(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "tool-call")
        return {
          type: "text" as const,
          text: `[called tool ${b.name} with ${JSON.stringify(b.input).slice(0, 2000)}]`,
        };
      if (b.type === "tool-result")
        return {
          type: "text" as const,
          text: `[tool ${b.name} ${b.isError ? "error" : "result"}]\n${b.output}`,
        };
      return b;
    }),
  }));
}
