// Environment for child processes the agent starts (bash, MCP servers): the parent env minus
// provider API keys, database URLs and exa's own EXA_* settings.

// ---------- constants ----------
const SECRET_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_GENERATIVE_AI_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "DATABASE_URL",
  "OPENCODE_API_KEY",
  "CEREBRAS_API_KEY",
]);
const EXA_ENV_PREFIX = "EXA_";

// ---------- scrubbed env ----------
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SECRET_ENV.has(k) || k.startsWith(EXA_ENV_PREFIX)) continue;
    out[k] = v;
  }
  return out;
}
