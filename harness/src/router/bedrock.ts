// Amazon Bedrock Converse client — first live inference path in the harness.
// Auth precedence (AWS documented): bearer (AWS_BEARER_TOKEN_BEDROCK) first,
// then SigV4 (AWS_ACCESS_KEY_ID/SECRET via @aws-sdk/client-bedrock-runtime).
// Same context in, text out. Errors carry `.status`; never include secrets.
// Types live in ./types.ts.

import { defaultKeystore, type Keystore } from "./keystore.js";
import type { ChatMsg, ConverseBody, TokenUsage } from "./types.js";

export class BedrockClient {
  constructor(private readonly keystore: Keystore = defaultKeystore) {}

  endpoint(region: string): string {
    return `https://bedrock-runtime.${region}.amazonaws.com`;
  }

  /** Pure builder — unit-tested offline, shared by both auth paths. */
  buildConverseBody(system: string, messages: ChatMsg[], maxTokens: number): ConverseBody {
    return {
      messages: messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
      ...(system ? { system: [{ text: system }] } : {}),
      inferenceConfig: { maxTokens },
    };
  }

  async converse(
    modelId: string,
    system: string,
    messages: ChatMsg[],
    maxTokens: number,
  ): Promise<{ text: string; ms: number; usage: TokenUsage }> {
    const started = Date.now();
    const auth = this.keystore.bedrockAuth();
    if (!auth) throw new Error("missing Bedrock credentials — set AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID/SECRET (see .env.example)");
    const region = this.keystore.bedrockRegion();

    if (auth.kind === "bearer") {
      const res = await fetch(`${this.endpoint(region)}/model/${modelId}/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify(this.buildConverseBody(system, messages, maxTokens)),
      });
      if (!res.ok) {
        const err = new Error(`bedrock converse ${res.status}: ${(await res.text()).slice(0, 500)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      const json = (await res.json()) as {
        output?: { message?: { content?: Array<{ text?: string }> } };
        usage?: { inputTokens?: number; outputTokens?: number };
      };
      const text = (json.output?.message?.content ?? []).map((b) => b.text ?? "").join("");
      return { text, ms: Date.now() - started, usage: toUsage(json.usage) };
    }

    const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({ region });
    const out = await client.send(new ConverseCommand({ modelId, ...this.buildConverseBody(system, messages, maxTokens) }));
    const text = ((out.output?.message?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    return { text, ms: Date.now() - started, usage: toUsage(out.usage) };
  }
}

export const defaultBedrock = new BedrockClient();

/** Coerce Converse usage (both auth paths) — missing counts become 0. */
function toUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): TokenUsage {
  return {
    inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
  };
}

export function bedrockEndpoint(region: string): string {
  return defaultBedrock.endpoint(region);
}

/** Pure builder — unit-tested offline, shared by both auth paths. */
export function buildConverseBody(system: string, messages: ChatMsg[], maxTokens: number): ConverseBody {
  return defaultBedrock.buildConverseBody(system, messages, maxTokens);
}

export async function bedrockConverse(
  modelId: string,
  system: string,
  messages: ChatMsg[],
  maxTokens: number,
): Promise<{ text: string; ms: number; usage: TokenUsage }> {
  return defaultBedrock.converse(modelId, system, messages, maxTokens);
}
