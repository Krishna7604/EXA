// Provider catalog — one entry per AI provider the router can serve.
// Model slugs stay OpenRouter-style ("provider/model") so swapping providers
// is a string change; the context pipeline (CLAUDE.md + session + tools)
// is NEVER rebuilt per provider — router only swaps model + key + endpoint.
// Types live in ./types.ts.
import type { ProviderDef, ProviderId } from "./types.js";

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter (aggregator — 1 key covers 200+ models)",
    envVars: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    prefixes: ["anthropic", "openai", "google", "mistral", "deepseek", "xai", "meta", "groq"],
    examples: ["anthropic/claude-opus-latest", "openai/gpt-5", "google/gemini-2.5-pro"],
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock (Converse API — bearer key or SigV4)",
    envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
    baseURL: "https://bedrock-runtime.{region}.amazonaws.com",
    prefixes: ["bedrock"],
    examples: [
      "bedrock/us.anthropic.claude-sonnet-4-6",
      "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
      "bedrock/amazon.nova-micro-v1:0",
    ],
    docs: "https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html",
  },
  {
    id: "anthropic",
    label: "Anthropic (direct)",
    envVars: ["ANTHROPIC_API_KEY"],
    baseURL: "https://api.anthropic.com/v1",
    prefixes: ["anthropic"],
    examples: ["anthropic/claude-opus-latest", "anthropic/claude-sonnet"],
    docs: "https://docs.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI (direct)",
    envVars: ["OPENAI_API_KEY"],
    baseURL: "https://api.openai.com/v1",
    prefixes: ["openai"],
    examples: ["openai/gpt-5", "openai/gpt-5-mini"],
    docs: "https://platform.openai.com/docs",
  },
  {
    id: "google",
    label: "Google (direct)",
    envVars: ["GOOGLE_GENERATIVE_AI_KEY", "GEMINI_API_KEY"],
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    prefixes: ["google"],
    examples: ["google/gemini-2.5-pro", "google/gemini-2.5-flash"],
    docs: "https://ai.google.dev",
  },
  {
    id: "mistral",
    label: "Mistral (direct)",
    envVars: ["MISTRAL_API_KEY"],
    baseURL: "https://api.mistral.ai/v1",
    prefixes: ["mistral"],
    examples: ["mistral/mistral-large", "mistral/mistral-small"],
    docs: "https://docs.mistral.ai",
  },
  {
    id: "deepseek",
    label: "DeepSeek (direct)",
    envVars: ["DEEPSEEK_API_KEY"],
    baseURL: "https://api.deepseek.com/v1",
    prefixes: ["deepseek"],
    examples: ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
    docs: "https://api-docs.deepseek.com",
  },
  {
    id: "xai",
    label: "xAI (direct)",
    envVars: ["XAI_API_KEY"],
    baseURL: "https://api.x.ai/v1",
    prefixes: ["xai"],
    examples: ["xai/grok-4", "xai/grok-4-mini"],
    docs: "https://docs.x.ai",
  },
  {
    id: "groq",
    label: "Groq (direct — fast Llama/open models)",
    envVars: ["GROQ_API_KEY"],
    baseURL: "https://api.groq.com/openai/v1",
    prefixes: ["groq", "meta"],
    examples: ["groq/llama-3.3-70b", "meta/llama-3.3-70b"],
    docs: "https://console.groq.com/docs",
  },
];

export class ProviderCatalog {
  constructor(private readonly providers: ProviderDef[] = PROVIDERS) {}

  list(): ProviderDef[] {
    return [...this.providers];
  }

  getProvider(id: ProviderId): ProviderDef {
    const p = this.providers.find((x) => x.id === id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  /** "anthropic/claude-opus" -> "anthropic". Bare "gpt-5" -> "openrouter" (aggregator default). */
  prefixOf(model: string): string {
    const i = model.indexOf("/");
    return i > 0 ? model.slice(0, i).toLowerCase() : "openrouter";
  }

  /** prefix "bedrock" -> "bedrock"; unknown -> null (openrouter-only). */
  directProviderFor(prefix: string): ProviderId | null {
    for (const p of this.providers) {
      if (p.id !== "openrouter" && p.prefixes.includes(prefix)) return p.id;
    }
    return null;
  }
}

export const defaultCatalog = new ProviderCatalog();

export function getProvider(id: ProviderId): ProviderDef {
  return defaultCatalog.getProvider(id);
}

/** "anthropic/claude-opus" -> "anthropic". Bare "gpt-5" -> "openrouter" (aggregator default). */
export function prefixOf(model: string): string {
  return defaultCatalog.prefixOf(model);
}
