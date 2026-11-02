// Anthropic Messages API streaming, with prompt caching on the stable prefix
// (system, tools, and the conversation up to the latest message).
import {
  type FinishReason,
  type ModelChunk,
  type ModelMessage,
  type ModelRequest,
  readSse,
} from "@exa/protocol";
import type { AdapterOpts } from "../models/adapter.model.ts";
import { flattenToolBlocks, httpError, parseArgs } from "./adapter-common.ts";

// ---------- constants ----------
const STOP: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  refusal: "content-filter",
  pause_turn: "stop",
};

// ---------- types ----------
type Block =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: { type: "ephemeral" };
    };

// ---------- anthropic adapter ----------
export function toAnthropic(req: ModelRequest): {
  system: Block[];
  messages: Array<{ role: "user" | "assistant"; content: Block[] }>;
} {
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  }));
  // cache breakpoints: last two user messages (the moving tail of the cached prefix)
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    if (messages[i].role !== "user") continue;
    const last = messages[i].content[messages[i].content.length - 1];
    if (last) {
      last.cache_control = { type: "ephemeral" };
      marked++;
    }
  }
  const system: Block[] = req.system
    ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
    : [];
  return { system, messages };
}

export async function* streamAnthropic(
  req: ModelRequest,
  opts: AdapterOpts,
): AsyncGenerator<ModelChunk> {
  const { system, messages } = toAnthropic(
    req.tools?.length ? req : { ...req, messages: flattenToolBlocks(req.messages) },
  );
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: req.maxTokens ?? 8192,
    system,
    messages,
    stream: true,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(i === req.tools!.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
  }
  if (req.options) Object.assign(body, req.options);
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.baseURL.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(opts.key ? { "x-api-key": opts.key } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw await httpError(res, "anthropic");
  yield { type: "start", model: opts.model, provider: "anthropic" };

  const blocks = new Map<
    number,
    { kind: "text" | "tool" | "thinking" | "other"; id?: string; name?: string; json: string }
  >();
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let finish: FinishReason = "stop";
  const toolCalls: ModelChunk[] = [];

  for await (const frame of readSse(res.body, opts.signal)) {
    if (!frame.data) continue;
    let ev: any;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage ?? {};
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block ?? {};
        const kind =
          cb.type === "text"
            ? "text"
            : cb.type === "tool_use"
              ? "tool"
              : cb.type === "thinking"
                ? "thinking"
                : "other";
        blocks.set(ev.index, { kind, id: cb.id, name: cb.name, json: "" });
        if (kind === "text" && cb.text) yield { type: "text-delta", text: cb.text };
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        const b = blocks.get(ev.index);
        if (d.type === "text_delta" && d.text) yield { type: "text-delta", text: d.text };
        else if (d.type === "thinking_delta" && d.thinking)
          yield { type: "reasoning-delta", text: d.thinking };
        else if (d.type === "input_json_delta" && b) b.json += d.partial_json ?? "";
        break;
      }
      case "content_block_stop": {
        const b = blocks.get(ev.index);
        if (b?.kind === "tool" && b.name)
          toolCalls.push({
            type: "tool-call",
            callId: b.id ?? `toolu_${ev.index}`,
            name: b.name,
            input: parseArgs(b.json),
          });
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) finish = STOP[ev.delta.stop_reason] ?? "stop";
        if (ev.usage?.output_tokens !== undefined) usage.output = ev.usage.output_tokens;
        break;
      }
      case "error": {
        const type = ev.error?.type ?? "error";
        const status =
          type === "overloaded_error"
            ? 529
            : type === "rate_limit_error"
              ? 429
              : type === "api_error"
                ? 500
                : 400;
        yield {
          type: "error",
          message: `anthropic: ${type}: ${ev.error?.message ?? ""}`,
          status,
          retryable: status >= 429,
        };
        return;
      }
    }
  }
  for (const c of toolCalls) yield c;
  yield { type: "finish", reason: toolCalls.length ? "tool-calls" : finish, usage };
}

// ---------- helpers ----------

function toAnthropicBlock(b: ModelMessage["content"][number]): Block {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text || " " };
    case "image":
      return { type: "image", source: { type: "base64", media_type: b.mime, data: b.data } };
    case "tool-call":
      return { type: "tool_use", id: b.callId, name: b.name, input: b.input ?? {} };
    case "tool-result":
      return {
        type: "tool_result",
        tool_use_id: b.callId,
        content: b.output || "(empty)",
        ...(b.isError ? { is_error: true } : {}),
      };
    default:
      throw new Error(`unsupported content block: ${(b as { type: string }).type}`);
  }
}
