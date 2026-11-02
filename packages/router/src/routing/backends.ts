// Default backend pool for the `exa` virtual model. Backends are config, never hard-wired:
// replace the pool via EXA_BACKENDS (JSON), since availability/terms of free models change.
import type { Tier } from "@exa/protocol";

// ---------- types ----------
export interface Backend {
  id: string;
  provider: string;
  model: string;
  tier: Tier;
  /** Zero-cost backend (free tier / free model). */
  free?: boolean;
  /** Reliable at function calling — required for turns that send tools. */
  supportsTools: boolean;
  contextWindow: number;
  priority: number;
  enabled?: boolean;
  notes?: string;
}

// ---------- default pool ----------
/** Default pool. Replace via EXA_BACKENDS (JSON) — availability/terms of free models change. */
export const DEFAULT_BACKENDS: Backend[] = [
  {
    id: "bedrock-nova-micro",
    provider: "bedrock",
    model: "eu.amazon.nova-micro-v1:0",
    tier: "fast",
    supportsTools: true,
    contextWindow: 128_000,
    priority: 10,
  },
  {
    id: "groq-llama-70b",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    tier: "fast",
    free: true,
    supportsTools: true,
    contextWindow: 128_000,
    priority: 20,
  },
  {
    id: "gemini-flash-lite",
    provider: "google",
    model: "gemini-2.5-flash-lite",
    tier: "fast",
    supportsTools: true,
    contextWindow: 1_000_000,
    priority: 30,
  },
  {
    id: "openrouter-free-fast",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    tier: "fast",
    free: true,
    supportsTools: false,
    contextWindow: 128_000,
    priority: 40,
  },
  {
    id: "bedrock-haiku",
    provider: "bedrock",
    model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    tier: "balanced",
    supportsTools: true,
    contextWindow: 200_000,
    priority: 10,
  },
  {
    id: "anthropic-haiku",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tier: "balanced",
    supportsTools: true,
    contextWindow: 200_000,
    priority: 15,
  },
  {
    id: "openrouter-qwen-coder-free",
    provider: "openrouter",
    model: "qwen/qwen3-coder:free",
    tier: "balanced",
    free: true,
    supportsTools: true,
    contextWindow: 262_000,
    priority: 20,
  },
  {
    id: "gemini-flash",
    provider: "google",
    model: "gemini-2.5-flash",
    tier: "balanced",
    supportsTools: true,
    contextWindow: 1_000_000,
    priority: 30,
  },
  {
    id: "openai-mini",
    provider: "openai",
    model: "gpt-5-mini",
    tier: "balanced",
    supportsTools: true,
    contextWindow: 400_000,
    priority: 40,
  },
  {
    id: "bedrock-sonnet",
    provider: "bedrock",
    model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    tier: "strong",
    supportsTools: true,
    contextWindow: 200_000,
    priority: 10,
  },
  {
    id: "anthropic-sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tier: "strong",
    supportsTools: true,
    contextWindow: 200_000,
    priority: 15,
  },
  {
    id: "openai-gpt5",
    provider: "openai",
    model: "gpt-5",
    tier: "strong",
    supportsTools: true,
    contextWindow: 400_000,
    priority: 20,
  },
  {
    id: "gemini-pro",
    provider: "google",
    model: "gemini-2.5-pro",
    tier: "strong",
    supportsTools: true,
    contextWindow: 1_000_000,
    priority: 30,
  },
];
