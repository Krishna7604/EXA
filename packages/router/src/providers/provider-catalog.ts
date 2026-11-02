// Provider catalog. Adding a provider = one entry. `kind` picks the wire adapter.
// Also resolves credentials for a provider from an env map.

// ---------- constants ----------
const DEFAULT_BEDROCK_REGION = "us-east-1";

// ---------- types ----------
export type ProviderKind = "openai" | "anthropic" | "bedrock";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  baseURL: string;
  /** Env vars holding a pool/BYOK key, first wins. Empty = no key needed (local). */
  envVars: string[];
  docs: string;
  /** OpenAI-compatible quirks. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  headers?: Record<string, string>;
}

export interface Credential {
  /** API key / bearer token. For bedrock SigV4 use `aws`. */
  key?: string;
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  region?: string;
  baseURL?: string;
  source: "byok_user" | "byok_tenant" | "pool" | "env";
}

// ---------- catalog ----------
export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    envVars: ["ANTHROPIC_API_KEY"],
    docs: "https://docs.claude.com/en/api/getting-started",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseURL: "https://api.openai.com/v1",
    envVars: ["OPENAI_API_KEY"],
    docs: "https://platform.openai.com/api-keys",
    maxTokensField: "max_completion_tokens",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    envVars: ["OPENROUTER_API_KEY"],
    docs: "https://openrouter.ai/keys",
    headers: { "HTTP-Referer": "https://github.com/exa-harness", "X-Title": "exa" },
  },
  {
    id: "google",
    label: "Google Gemini",
    kind: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_KEY", "GEMINI_API_KEY"],
    docs: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseURL: "https://api.groq.com/openai/v1",
    envVars: ["GROQ_API_KEY"],
    docs: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseURL: "https://api.deepseek.com/v1",
    envVars: ["DEEPSEEK_API_KEY"],
    docs: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "xai",
    label: "xAI",
    kind: "openai",
    baseURL: "https://api.x.ai/v1",
    envVars: ["XAI_API_KEY"],
    docs: "https://console.x.ai",
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai",
    baseURL: "https://api.mistral.ai/v1",
    envVars: ["MISTRAL_API_KEY"],
    docs: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai",
    baseURL: "https://api.together.xyz/v1",
    envVars: ["TOGETHER_API_KEY"],
    docs: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai",
    baseURL: "https://api.cerebras.ai/v1",
    envVars: ["CEREBRAS_API_KEY"],
    docs: "https://cloud.cerebras.ai",
  },
  // OpenCode Zen (OpenAI-compatible gateway). Endpoint/terms unverified — keep config-driven.
  {
    id: "opencode",
    label: "OpenCode Zen",
    kind: "openai",
    baseURL: "https://opencode.ai/zen/v1",
    envVars: ["OPENCODE_API_KEY"],
    docs: "https://opencode.ai/docs/zen",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    baseURL: "http://127.0.0.1:11434/v1",
    envVars: [],
    docs: "https://ollama.com",
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    kind: "bedrock",
    baseURL: "https://bedrock-runtime.{region}.amazonaws.com",
    envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
    docs: "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html",
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

// ---------- lookup ----------
export function getProvider(id: string): ProviderDef | undefined {
  return byId.get(id);
}

export function listProviders(): ProviderDef[] {
  return PROVIDERS;
}

/** "openai/gpt-5" → { provider: "openai", model: "gpt-5" }; bedrock ids keep their dots/colons. */
export function parseSlug(slug: string): { provider: string; model: string } {
  const i = slug.indexOf("/");
  if (i === -1) return { provider: slug, model: "" };
  return { provider: slug.slice(0, i), model: slug.slice(i + 1) };
}

// ---------- credentials ----------
/** Credentials straight from an env map (CLI direct mode and the server's platform pool). */
export function envCredential(
  provider: string,
  env: Record<string, string | undefined>,
  source: Credential["source"] = "env",
): Credential | null {
  const def = getProvider(provider);
  if (!def) return null;
  if (def.kind === "bedrock") return bedrockCredential(env, source);
  if (!def.envVars.length) return keylessCredential(provider, env, source);
  for (const v of def.envVars) {
    const k = env[v]?.trim();
    if (k) return { key: k, source };
  }
  return null;
}

// ---------- helpers ----------
/** Bedrock: bearer API key if present, else an AWS access key pair (SigV4). */
function bedrockCredential(
  env: Record<string, string | undefined>,
  source: Credential["source"],
): Credential | null {
  const region = env.BEDROCK_REGION?.trim() || env.AWS_REGION?.trim() || DEFAULT_BEDROCK_REGION;
  const bearer = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (bearer) return { key: bearer, region, source };
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!id || !secret) return null;
  const sessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
  return { aws: { accessKeyId: id, secretAccessKey: secret, sessionToken }, region, source };
}

/** Local providers (e.g. Ollama) need no key; `<PROVIDER>_BASE_URL` may override the URL. */
function keylessCredential(
  provider: string,
  env: Record<string, string | undefined>,
  source: Credential["source"],
): Credential {
  const base = env[`${provider.toUpperCase()}_BASE_URL`];
  return { source, ...(base ? { baseURL: base } : {}) };
}
