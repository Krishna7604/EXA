// Dispatch one request to one concrete provider/model with one credential.
import type { ModelChunk, ModelRequest } from "@exa/protocol";
import { streamAnthropic } from "../adapters/anthropic.adapter.ts";
import { streamBedrock } from "../adapters/bedrock/bedrock.adapter.ts";
import { streamOpenAI } from "../adapters/openai.adapter.ts";
import type { FetchFn } from "../models/adapter.model.ts";
import { costFor } from "../providers/pricing.ts";
import { type Credential, getProvider } from "../providers/provider-catalog.ts";

export async function* streamDirect(
  provider: string,
  model: string,
  req: ModelRequest,
  cred: Credential,
  signal: AbortSignal,
  fetchFn?: FetchFn,
): AsyncGenerator<ModelChunk> {
  const def = getProvider(provider);
  if (!def) throw new Error(`unknown provider "${provider}"`);
  const base = cred.baseURL ?? def.baseURL;
  let inner: AsyncGenerator<ModelChunk>;
  switch (def.kind) {
    case "anthropic":
      inner = streamAnthropic(req, {
        model,
        key: cred.key,
        baseURL: base,
        headers: def.headers,
        fetch: fetchFn,
        signal,
      });
      break;
    case "bedrock":
      inner = streamBedrock(req, {
        model,
        region: cred.region ?? "us-east-1",
        key: cred.key,
        aws: cred.aws,
        fetch: fetchFn,
        signal,
        baseURL: cred.baseURL,
      });
      break;
    default:
      inner = streamOpenAI(req, {
        model,
        key: cred.key,
        baseURL: base,
        headers: def.headers,
        fetch: fetchFn,
        signal,
        maxTokensField: def.maxTokensField,
        providerId: provider,
      });
  }
  for await (const c of inner) {
    // attach list-price cost when the provider didn't report one
    if (c.type === "finish" && c.cost === undefined)
      yield { ...c, cost: costFor(`${provider}/${model}`, c.usage) };
    else yield c;
  }
}
