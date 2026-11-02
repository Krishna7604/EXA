// Approximate list prices, USD per 1M tokens. Used for usage/cost display and quotas only —
// provider-reported cost (e.g. OpenRouter usage.cost) always wins. Keep this table in config
// for production; values here are reasonable defaults and may drift.
import type { Tokens } from "@exa/protocol";

// ---------- constants ----------
/** Prices are quoted per this many tokens. */
const TOKENS_PER_UNIT = 1_000_000;
/** Round costs to 1e-8 USD to avoid float noise in stored totals. */
const COST_PRECISION = 1e8;

/** First matching pattern wins, so more specific models come before their families. */
const PRICE_TABLE: Array<[RegExp, Price]> = [
  [/:free$|^ollama\//, { input: 0, output: 0 }],
  [/claude-opus-4|claude-opus-5/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [
    /claude-sonnet-4|claude-sonnet-5|claude-3-7-sonnet|claude-3-5-sonnet/,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  ],
  [/claude-haiku-4|claude-haiku-5/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/claude-3-5-haiku/, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  [/nova-micro/, { input: 0.035, output: 0.14 }],
  [/nova-lite/, { input: 0.06, output: 0.24 }],
  [/nova-pro/, { input: 0.8, output: 3.2 }],
  [/gpt-5-nano/, { input: 0.05, output: 0.4, cacheRead: 0.005 }],
  [/gpt-5-mini/, { input: 0.25, output: 2, cacheRead: 0.025 }],
  [/gpt-5/, { input: 1.25, output: 10, cacheRead: 0.125 }],
  [/gpt-4\.1-mini/, { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  [/gpt-4o-mini/, { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  [/gpt-4o|gpt-4\.1/, { input: 2.5, output: 10, cacheRead: 1.25 }],
  [/gemini-2\.5-flash-lite/, { input: 0.1, output: 0.4 }],
  [/gemini-2\.5-flash/, { input: 0.3, output: 2.5 }],
  [/gemini-2\.5-pro/, { input: 1.25, output: 10 }],
  [/deepseek-chat|deepseek-v3/, { input: 0.27, output: 1.1, cacheRead: 0.07 }],
  [/deepseek-reasoner|deepseek-r1/, { input: 0.55, output: 2.19, cacheRead: 0.14 }],
  [/llama-3\.3-70b|llama3-70b/, { input: 0.59, output: 0.79 }],
  [/llama-3\.1-8b|llama3-8b/, { input: 0.05, output: 0.08 }],
  [/qwen3-coder/, { input: 0.4, output: 1.6 }],
  [/grok-4/, { input: 3, output: 15 }],
  [/mistral-large/, { input: 2, output: 6 }],
  [/codestral|devstral/, { input: 0.3, output: 0.9 }],
];

// ---------- types ----------
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ---------- pricing ----------
export function priceFor(model: string): Price | null {
  for (const [re, p] of PRICE_TABLE) if (re.test(model)) return p;
  return null;
}

/** List-price cost in USD for a usage record; 0 for unknown models. */
export function costFor(model: string, t: Partial<Tokens>): number {
  const p = priceFor(model);
  if (!p) return 0;
  const usd =
    ((t.input ?? 0) * p.input +
      (t.output ?? 0) * p.output +
      (t.cacheRead ?? 0) * (p.cacheRead ?? p.input) +
      (t.cacheWrite ?? 0) * (p.cacheWrite ?? p.input)) /
    TOKENS_PER_UNIT;
  return Math.round(usd * COST_PRECISION) / COST_PRECISION;
}
