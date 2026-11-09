// OpenAI-compatible chat/completions streaming (OpenAI, OpenRouter, Groq, DeepSeek, Gemini,
// xAI, Mistral, Together, Cerebras, Ollama, OpenCode Zen).
import { type FinishReason, type ModelChunk, type ModelRequest, readSse } from "@exa/protocol";
import type { AdapterOpts } from "../models/adapter.model.ts";
import { flattenToolBlocks, httpError, httpErrorFromBody, parseArgs } from "./adapter-common.ts";

// ---------- constants ----------
const PAYMENT_REQUIRED = 402;
/** OpenRouter's low-credit error: "...You requested up to 8192 tokens, but can only afford 1366." */
const AFFORDABLE_TOKENS = /can only afford (\d+)/i;
/** Stay a little under what the provider says is affordable (the prompt also costs credits). */
const AFFORDABLE_MARGIN = 0.9;
/** Below this, an answer would be too short to be useful; report the error instead. */
const MIN_RETRY_MAX_TOKENS = 256;
const FINISH: Record<string, FinishReason> = {
  stop: "stop",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  length: "length",
  content_filter: "content-filter",
};

// ---------- types ----------
type OAIMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

// ---------- openai adapter ----------
export function toOpenAIMessages(req: ModelRequest): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      const calls = m.content.filter((b) => b.type === "tool-call") as Array<{
        callId: string;
        name: string;
        input: unknown;
      }>;
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.callId,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // user: tool results become role=tool messages (must directly follow the assistant call)
    const results = m.content.filter((b) => b.type === "tool-result") as Array<{
      callId: string;
      output: string;
      isError?: boolean;
    }>;
    for (const r of results)
      out.push({
        role: "tool",
        tool_call_id: r.callId,
        content: r.isError ? `Error: ${r.output}` : r.output,
      });
    const rest = m.content.filter((b) => b.type === "text" || b.type === "image");
    if (rest.length) {
      const hasImage = rest.some((b) => b.type === "image");
      out.push({
        role: "user",
        content: hasImage
          ? rest.map((b) =>
              b.type === "text"
                ? { type: "text" as const, text: b.text }
                : {
                    type: "image_url" as const,
                    image_url: {
                      url: `data:${(b as { mime: string }).mime};base64,${(b as { data: string }).data}`,
                    },
                  },
            )
          : rest.map((b) => (b as { text: string }).text).join("\n\n"),
      });
    }
  }
  return out;
}

export async function* streamOpenAI(
  req: ModelRequest,
  opts: AdapterOpts & {
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    providerId: string;
  },
): AsyncGenerator<ModelChunk> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAIMessages(
      req.tools?.length ? req : { ...req, messages: flattenToolBlocks(req.messages) },
    ),
    stream: true,
    stream_options: { include_usage: true },
    [opts.maxTokensField ?? "max_tokens"]: req.maxTokens ?? 8192,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (opts.providerId === "openrouter") body.usage = { include: true };
  if (req.options) Object.assign(body, req.options);

  const res = await postWithAffordableBudget(opts, body, opts.maxTokensField ?? "max_tokens");

  yield { type: "start", model: opts.model, provider: opts.providerId };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: FinishReason | null = null;
  let usage: { input: number; output: number; reasoning: number; cacheRead: number } | null = null;
  let cost: number | undefined;

  for await (const frame of readSse(res.body, opts.signal)) {
    const data = frame.data.trim();
    if (!data || data === "[DONE]") continue;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) {
      const status = Number(json.error.code) || 0;
      yield {
        type: "error",
        message: `${opts.providerId}: ${json.error.message ?? JSON.stringify(json.error)}`.slice(
          0,
          800,
        ),
        status,
        retryable: status === 0 || status === 429 || status >= 500,
      };
      return;
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning)
        yield { type: "reasoning-delta", text: reasoning };
      if (typeof delta.content === "string" && delta.content)
        yield { type: "text-delta", text: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : calls.size;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
    if (choice?.finish_reason) finish = FINISH[choice.finish_reason] ?? "stop";
    if (json.usage) {
      usage = {
        input:
          (json.usage.prompt_tokens ?? 0) - (json.usage.prompt_tokens_details?.cached_tokens ?? 0),
        output: json.usage.completion_tokens ?? 0,
        reasoning: json.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cacheRead: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
      if (typeof json.usage.cost === "number") cost = json.usage.cost;
    }
  }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    yield {
      type: "tool-call",
      callId: c.id || `call_${crypto.randomUUID().slice(0, 12)}`,
      name: c.name,
      input: parseArgs(c.args),
    };
  }
  yield {
    type: "finish",
    reason: calls.size ? "tool-calls" : (finish ?? "stop"),
    usage: usage ?? {},
    ...(cost !== undefined ? { cost } : {}),
  };
}

// ---------- helpers ----------
type ChatOpts = AdapterOpts & { providerId: string };

function postChat(opts: ChatOpts, body: Record<string, unknown>): Promise<Response> {
  const f = opts.fetch ?? fetch;
  return f(`${opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/**
 * OpenRouter answers 402 "can only afford N tokens" when the account's credits can't cover the
 * requested output budget. Retry once with a budget that fits, so a low balance shortens
 * answers instead of stopping the chat. Any other failure is thrown as before.
 */
async function postWithAffordableBudget(
  opts: ChatOpts,
  body: Record<string, unknown>,
  field: string,
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const res = await postChat(opts, body);
  if (res.ok && res.body) return res as Response & { body: ReadableStream<Uint8Array> };
  const text = await res.text().catch(() => "");
  const budget = res.status === PAYMENT_REQUIRED ? affordableBudget(text, body[field]) : null;
  if (budget === null) throw httpErrorFromBody(res, opts.providerId, text);
  const retry = await postChat(opts, { ...body, [field]: budget });
  if (!retry.ok || !retry.body) throw await httpError(retry, opts.providerId);
  return retry as Response & { body: ReadableStream<Uint8Array> };
}

/** The budget to retry with, or null when the error isn't a "can only afford" one. */
function affordableBudget(errorBody: string, requested: unknown): number | null {
  const match = errorBody.match(AFFORDABLE_TOKENS);
  if (!match) return null;
  const budget = Math.floor(Number(match[1]) * AFFORDABLE_MARGIN);
  if (budget < MIN_RETRY_MAX_TOKENS || budget >= Number(requested)) return null;
  return budget;
}
