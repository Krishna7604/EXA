// Maps a ModelRequest onto the Bedrock Converse API request body (messages, system, tools,
// prompt-cache points).
import type { ContentBlock, ModelMessage, ModelRequest } from "@exa/protocol";
import { flattenToolBlocks } from "../adapter-common.ts";

// ---------- constants ----------
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_IMAGE_FORMAT = "png";
/** Bedrock rejects empty text blocks / tool results, so send a placeholder instead. */
const EMPTY_TEXT = " ";
const EMPTY_TOOL_OUTPUT = "(empty)";

const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const CACHE_POINT_MODELS = /anthropic\.claude|amazon\.nova/;
/** Only Claude accepts a cache point after the tool list. */
const TOOL_CACHE_POINT_MODELS = /anthropic\.claude/;

// ---------- request mapping ----------
export function toConverse(req: ModelRequest, model: string): Record<string, unknown> {
  const msgs: ModelMessage[] = req.tools?.length ? req.messages : flattenToolBlocks(req.messages);
  const cache = CACHE_POINT_MODELS.test(model);
  const body: Record<string, unknown> = {
    messages: msgs.map(toConverseMessage),
    inferenceConfig: inferenceConfig(req),
  };
  if (req.system) body.system = [{ text: req.system }, ...(cache ? [cachePoint()] : [])];
  if (req.tools?.length)
    body.toolConfig = toolConfig(req, cache && TOOL_CACHE_POINT_MODELS.test(model));
  if (req.options) body.additionalModelRequestFields = req.options;
  return body;
}

// ---------- helpers ----------
function cachePoint(): { cachePoint: { type: string } } {
  return { cachePoint: { type: "default" } };
}

function inferenceConfig(req: ModelRequest): Record<string, unknown> {
  return {
    maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

function toConverseMessage(m: ModelMessage): { role: string; content: unknown[] } {
  return { role: m.role, content: m.content.map(toConverseBlock) };
}

function toConverseBlock(b: ContentBlock): unknown {
  switch (b.type) {
    case "text":
      return { text: b.text || EMPTY_TEXT };
    case "image": {
      const format = IMAGE_FORMATS[b.mime] ?? DEFAULT_IMAGE_FORMAT;
      return { image: { format, source: { bytes: b.data } } };
    }
    case "tool-call":
      return { toolUse: { toolUseId: b.callId, name: b.name, input: b.input ?? {} } };
    case "tool-result":
      return {
        toolResult: {
          toolUseId: b.callId,
          content: [{ text: b.output || EMPTY_TOOL_OUTPUT }],
          status: b.isError ? "error" : "success",
        },
      };
  }
}

function toolConfig(req: ModelRequest, withCachePoint: boolean): Record<string, unknown> {
  const specs = (req.tools ?? []).map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.parameters },
    },
  }));
  return { tools: [...specs, ...(withCachePoint ? [cachePoint()] : [])] };
}
