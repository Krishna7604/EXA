// Router slice — shared types. No runtime code; import with `import type`.
export type ProviderId =
  | "openrouter"
  | "bedrock"
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "deepseek"
  | "xai"
  | "groq";

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** ENV var(s) holding the key — first hit wins. */
  envVars: string[];
  /** Direct API base (used when BYOK direct; OpenRouter covers all via one key). */
  baseURL: string;
  /** Example slugs routed here (prefix before "/"). */
  prefixes: string[];
  examples: string[];
  docs: string;
}

// --- Amazon Bedrock credentials -------------------------------------------
// Two supported shapes (AWS documented precedence: bearer first, then SigV4):
//   A: AWS_BEARER_TOKEN_BEDROCK=<bedrock-api-key> (short- or long-term key)
//   B: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
export type BedrockAuth =
  | { kind: "bearer"; token: string }
  | { kind: "sigv4"; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

export interface ConverseBody {
  messages: Array<{ role: ChatMsg["role"]; content: Array<{ text: string }> }>;
  system?: Array<{ text: string }>;
  inferenceConfig: { maxTokens: number };
}

/** Token counts reported by Bedrock Converse `usage` (0 when absent). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type Strategy = "direct-if-key-else-openrouter" | "always-openrouter" | "direct-only";

export interface ResolvedRoute {
  model: string;
  /** Native model id to send to the endpoint (prefix stripped for direct). */
  directModel: string;
  provider: ProviderId;
  endpoint: string;
  via: "openrouter" | "direct";
  /** Bedrock region (only set for bedrock routes). */
  region?: string;
}

export interface RouterConfig {
  model: string;
  fallbacks?: Array<{ model: string }>;
  routing?: { strategy?: string };
}
