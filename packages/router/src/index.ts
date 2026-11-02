// @exa/router: model wire adapters (Anthropic, OpenAI-compatible, Bedrock), the `exa` virtual
// model router, the model gateway, the provider catalog + pricing, and the BYOK key vault.

export { flattenToolBlocks, parseArgs } from "./adapters/adapter-common.ts";
export { streamAnthropic, toAnthropic } from "./adapters/anthropic.adapter.ts";
export { streamBedrock } from "./adapters/bedrock/bedrock.adapter.ts";
export { toConverse } from "./adapters/bedrock/converse.ts";
export { EventStreamDecoder } from "./adapters/bedrock/event-stream.ts";
export { signV4 } from "./adapters/bedrock/sigv4.ts";
export { streamOpenAI, toOpenAIMessages } from "./adapters/openai.adapter.ts";
export * from "./gateway/direct.ts";
export * from "./gateway/gateway.ts";
export type { FetchFn } from "./models/adapter.model.ts";
export * from "./models/gateway.model.ts";
export * from "./providers/pricing.ts";
export * from "./providers/provider-catalog.ts";
export { type Backend, DEFAULT_BACKENDS } from "./routing/backends.ts";
export { classify } from "./routing/classifier.ts";
export * from "./routing/exa.router.ts";
export * from "./vault/key-vault.ts";
