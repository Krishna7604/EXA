#!/usr/bin/env bash
# One-command local server: dev login on, provider keys from an env file, a stable master key.
#   bun run dev                      # keys from harness/.env (or EXA_KEYS_FILE=path)
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS_FILE="${EXA_KEYS_FILE:-harness/.env}"
if [[ -f "$KEYS_FILE" ]]; then
  # load only provider-key lines; never echo values
  while IFS= read -r line; do
    [[ "$line" =~ ^(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GOOGLE_GENERATIVE_AI_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|AWS_BEARER_TOKEN_BEDROCK|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|BEDROCK_REGION)=(.+)$ ]] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  done < "$KEYS_FILE"
fi

mkdir -p "$HOME/.exa"
KEY_FILE="$HOME/.exa/dev-master-key"
[[ -f "$KEY_FILE" ]] || { openssl rand -base64 32 > "$KEY_FILE"; chmod 600 "$KEY_FILE"; }
export EXA_MASTER_KEY="$(cat "$KEY_FILE")"
export EXA_DEV_AUTH=1
export EXA_JWT_SECRET="${EXA_JWT_SECRET:-dev-only-jwt-secret-$(whoami)-change-me-in-prod}"

# Default "exa" pool for local dev: whatever keys are present.
if [[ -z "${EXA_BACKENDS:-}" && -n "${OPENROUTER_API_KEY:-}" ]]; then
  M="${EXA_DEV_MODEL:-~deepseek/deepseek-flash-latest}"
  export EXA_BACKENDS="[{\"id\":\"or-fast\",\"provider\":\"openrouter\",\"model\":\"$M\",\"tier\":\"fast\",\"supportsTools\":true,\"contextWindow\":128000,\"priority\":1},{\"id\":\"or-balanced\",\"provider\":\"openrouter\",\"model\":\"$M\",\"tier\":\"balanced\",\"supportsTools\":true,\"contextWindow\":128000,\"priority\":1},{\"id\":\"or-strong\",\"provider\":\"openrouter\",\"model\":\"$M\",\"tier\":\"strong\",\"supportsTools\":true,\"contextWindow\":128000,\"priority\":1}]"
fi

exec bun --no-env-file run apps/server/src/main.ts
