// Cost estimates for the chat sidebar. Values are approximate on-demand rates
// (USD per 1M tokens) — verify against AWS Bedrock pricing for your region.
// Displayed with a ~ prefix; unknown models show tokens with no cost.
import type { TokenUsage } from "../router/types.js";

interface PricedFamily {
  /** substring matched (lowercased) against the model id */
  match: string;
  inputPerMtok: number;
  outputPerMtok: number;
}

const PRICING: PricedFamily[] = [
  { match: "nova-micro", inputPerMtok: 0.035, outputPerMtok: 0.14 },
  { match: "nova-lite", inputPerMtok: 0.06, outputPerMtok: 0.24 },
  { match: "nova-pro", inputPerMtok: 0.8, outputPerMtok: 3.2 },
  { match: "haiku", inputPerMtok: 1.0, outputPerMtok: 5.0 },
  { match: "sonnet", inputPerMtok: 3.0, outputPerMtok: 15.0 },
  { match: "opus", inputPerMtok: 15.0, outputPerMtok: 75.0 },
  { match: "gpt-5-mini", inputPerMtok: 0.25, outputPerMtok: 2.0 },
  { match: "gpt-5", inputPerMtok: 1.25, outputPerMtok: 10.0 },
  { match: "gemini-2.5-flash", inputPerMtok: 0.3, outputPerMtok: 2.5 },
  { match: "gemini-2.5-pro", inputPerMtok: 1.25, outputPerMtok: 10.0 },
  { match: "grok-4-mini", inputPerMtok: 0.5, outputPerMtok: 4.0 },
  { match: "grok-4", inputPerMtok: 3.0, outputPerMtok: 15.0 },
  { match: "deepseek", inputPerMtok: 0.27, outputPerMtok: 1.1 },
  { match: "mistral-large", inputPerMtok: 2.0, outputPerMtok: 6.0 },
  { match: "mistral-small", inputPerMtok: 1.0, outputPerMtok: 3.0 },
  { match: "llama-3.3-70b", inputPerMtok: 0.35, outputPerMtok: 0.4 },
];

/** Estimated USD for one call, or null when the model family is unknown. */
export function priceFor(modelId: string, usage: TokenUsage): number | null {
  const lower = modelId.toLowerCase();
  const row = PRICING.find((p) => lower.includes(p.match));
  if (!row) return null;
  return (usage.inputTokens * row.inputPerMtok + usage.outputTokens * row.outputPerMtok) / 1_000_000;
}

/** Rough input-size estimate (chars/4) for user prompts — shown as ~tok. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** ~$0.0001 style; null renders as em dash (handled by the renderer). */
export function formatCost(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined) return "—";
  if (costUsd < 0.01) return `~$${costUsd.toFixed(4)}`;
  return `~$${costUsd.toFixed(2)}`;
}
