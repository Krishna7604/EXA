# BYOK Multi-Provider Router + Keys (Bedrock First)

Date: 2026-09-21
Status: implemented in `harness/` v0.3.0 (13 bun tests green, typecheck clean)

## TL;DR
- User brings their own key(s) — **Amazon Bedrock first**, others anytime.
- Same context pipeline for every provider: `CLAUDE.md` + `work/session.jsonl` + tools are built once; the router only swaps `{ model, provider, endpoint, key }`.
- Keys live in `harness/.env` (gitignored), presence shown via `/keys`, values never logged (redacted in `runs.jsonl`).

## 1. Providers supported

| Slug prefix | Provider | Creds (ENV) | Endpoint |
|---|---|---|---|
| `bedrock/` | Amazon Bedrock (Converse) — **default** | `AWS_BEARER_TOKEN_BEDROCK` **or** `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY` (+opt `AWS_SESSION_TOKEN`); region `BEDROCK_REGION`/`AWS_REGION` (default `us-east-1`) | `https://bedrock-runtime.{region}.amazonaws.com` |
| any | OpenRouter aggregator (1 key, 200+ models) | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `anthropic/` | Anthropic direct | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai/` | OpenAI direct | `OPENAI_API_KEY` | `api.openai.com` |
| `google/` | Google direct | `GOOGLE_GENERATIVE_AI_KEY` | `generativelanguage...` |
| `mistral/` `deepseek/` `xai/` `groq/` `meta/` | Direct | respective `*_API_KEY` | respective bases |

Bedrock slugs carry the FULL Bedrock model id. Default is the light/fast one:
`bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` (Haiku 4.5, near-frontier).
Heavier option: `bedrock/us.anthropic.claude-sonnet-4-6` (Sonnet, inference-profile form).
`bedrock/` slugs are never sent to an aggregator — they require Bedrock creds.

## 2. Code map

- `src/router/providers.ts` — catalog (`PROVIDERS`, `prefixOf`)
- `src/router/keystore.ts` — `hasKey` / `requireKey` / `keyStatus` / `redact` + `bedrockAuth()` / `bedrockRegion()`
- `src/router/bedrock.ts` — `bedrockConverse()` (bearer→fetch, SigV4→AWS SDK), `buildConverseBody()`, `bedrockEndpoint()`
- `src/router.ts` — `resolveRoute()` / `routeChain()` / `shouldRetry()` / `describeRoute()` (no secrets in output)
- `src/agent.ts` — builds system prompt + last-20-turns history, calls Bedrock when routed there, persists both turns, `logRun()` (redacted)
- `agent.config.json` — `model` (default bedrock slug), `maxTokens` (Converse `inferenceConfig`), `routing.strategy`

## 3. Bedrock setup (you, with key in hand)

```bash
cd harness
cp .env.example .env
# Option A (simplest): Bedrock console > API keys
echo 'AWS_BEARER_TOKEN_BEDROCK=<paste>' >> .env
echo 'BEDROCK_REGION=us-east-1' >> .env   # your model-access region
# Option B: IAM SigV4 instead
# AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... [AWS_SESSION_TOKEN=...]
```

Check model access first (Converse fails without it): Bedrock console > Model access,
or `aws bedrock list-foundation-models --region=us-east-1 --by-provider anthropic`.
Verify offline (no spend): `bun run start -- -p "/model"` → `via bedrock (direct, ... region=...)`.
Live: `bun run start -- -p "hello"` → real Converse call, both turns in `work/session.jsonl`.

## 4. Key rules (security)

- `.env` is gitignored — never commit, never paste keys in chat/logs.
- `/keys` shows presence (`set`/`---`) only. `redact()` strips all credential values + `KEY=...` fragments before `runs.jsonl`.
- Safe retry: 429/5xx retried once ONLY if no mutating tool ran (no double-execute).
- Later (multi-user): OS keychain / encrypted per-user vault + spend caps. Out of scope for local single-user.

## 5. Routing strategies (`agent.config.json > routing.strategy`)

- `direct-if-key-else-openrouter` (default): direct key wins, else aggregator.
- `always-openrouter`: everything via `OPENROUTER_API_KEY`.
- `direct-only`: require the slug's own provider creds.
