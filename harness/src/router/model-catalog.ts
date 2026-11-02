// Curated model catalog — offline fallback with per-1M pricing for the
// /models picker. Live OpenRouter listing wins when a key + network exist;
// this table keeps the UI useful offline and covers Bedrock/direct slugs.
// Prices are approximate — verify against provider pricing pages.
import type { ProviderId } from "./types.js";

export interface CuratedModel {
  slug: string;
  provider: ProviderId;
  label: string;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  context: number | null;
  blurb: string;
}

export const CURATED_MODELS: CuratedModel[] = [
  // OpenRouter aggregator — 1 key, most popular picks
  { slug: "anthropic/claude-opus-4-1", provider: "openrouter", label: "Claude Opus 4.1", inputPerMtok: 15, outputPerMtok: 75, context: 200000, blurb: "frontier reasoning" },
  { slug: "anthropic/claude-sonnet-4-5", provider: "openrouter", label: "Claude Sonnet 4.5", inputPerMtok: 3, outputPerMtok: 15, context: 200000, blurb: "balanced frontier" },
  { slug: "anthropic/claude-haiku-4-5", provider: "openrouter", label: "Claude Haiku 4.5", inputPerMtok: 1, outputPerMtok: 5, context: 200000, blurb: "fast + cheap" },
  { slug: "openai/gpt-5", provider: "openrouter", label: "GPT-5", inputPerMtok: 1.25, outputPerMtok: 10, context: 400000, blurb: "frontier" },
  { slug: "openai/gpt-5-mini", provider: "openrouter", label: "GPT-5 mini", inputPerMtok: 0.25, outputPerMtok: 2, context: 400000, blurb: "cheap default" },
  { slug: "google/gemini-2.5-pro", provider: "openrouter", label: "Gemini 2.5 Pro", inputPerMtok: 1.25, outputPerMtok: 10, context: 1000000, blurb: "long context" },
  { slug: "google/gemini-2.5-flash", provider: "openrouter", label: "Gemini 2.5 Flash", inputPerMtok: 0.3, outputPerMtok: 2.5, context: 1000000, blurb: "fast + cheap" },
  { slug: "xai/grok-4", provider: "openrouter", label: "Grok 4", inputPerMtok: 3, outputPerMtok: 15, context: 256000, blurb: "xAI frontier" },
  { slug: "deepseek/deepseek-chat", provider: "openrouter", label: "DeepSeek V3", inputPerMtok: 0.27, outputPerMtok: 1.1, context: 64000, blurb: "open + cheap" },
  { slug: "mistral/mistral-large", provider: "openrouter", label: "Mistral Large", inputPerMtok: 2, outputPerMtok: 6, context: 128000, blurb: "EU model" },
  { slug: "meta/llama-3.3-70b", provider: "openrouter", label: "Llama 3.3 70B", inputPerMtok: 0.35, outputPerMtok: 0.4, context: 128000, blurb: "open weights" },
  { slug: "groq/llama-3.3-70b", provider: "openrouter", label: "Llama 3.3 70B (Groq fast)", inputPerMtok: 0.35, outputPerMtok: 0.4, context: 128000, blurb: "fast inference" },
  // Bedrock — full Bedrock model ids
  { slug: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", provider: "bedrock", label: "Haiku 4.5 (Bedrock)", inputPerMtok: 1, outputPerMtok: 5, context: 200000, blurb: "light + fast" },
  { slug: "bedrock/us.anthropic.claude-sonnet-4-6", provider: "bedrock", label: "Sonnet (Bedrock)", inputPerMtok: 3, outputPerMtok: 15, context: 200000, blurb: "heavier" },
  { slug: "bedrock/eu.amazon.nova-micro-v1:0", provider: "bedrock", label: "Nova Micro (Bedrock)", inputPerMtok: 0.035, outputPerMtok: 0.14, context: 128000, blurb: "cheapest" },
  { slug: "bedrock/eu.amazon.nova-lite-v1:0", provider: "bedrock", label: "Nova Lite (Bedrock)", inputPerMtok: 0.06, outputPerMtok: 0.24, context: 300000, blurb: "cheap multimodal" },
  // Direct providers — same slugs via own keys
  { slug: "anthropic/claude-sonnet-4-5", provider: "anthropic", label: "Sonnet direct", inputPerMtok: 3, outputPerMtok: 15, context: 200000, blurb: "direct Anthropic" },
  { slug: "openai/gpt-5-mini", provider: "openai", label: "GPT-5 mini direct", inputPerMtok: 0.25, outputPerMtok: 2, context: 400000, blurb: "direct OpenAI" },
  { slug: "google/gemini-2.5-flash", provider: "google", label: "Flash direct", inputPerMtok: 0.3, outputPerMtok: 2.5, context: 1000000, blurb: "direct Google" },
];

export function modelsFor(provider?: string): CuratedModel[] {
  if (!provider || provider === "all") return [...CURATED_MODELS];
  return CURATED_MODELS.filter((m) => m.provider === provider || m.slug.startsWith(`${provider}/`));
}

export function findCurated(slug: string): CuratedModel | undefined {
  return CURATED_MODELS.find((m) => m.slug === slug);
}

/** "$1.25 in / $10 out per 1M" — or "pricing n/a" when unknown. */
export function formatModelPrice(m: Pick<CuratedModel, "inputPerMtok" | "outputPerMtok">): string {
  if (m.inputPerMtok == null || m.outputPerMtok == null) return "pricing n/a";
  return `$${m.inputPerMtok} in / $${m.outputPerMtok} out per 1M`;
}
