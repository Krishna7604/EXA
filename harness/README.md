# exa harness (v0.5.0 — class-based, BYOK multi-provider, Bedrock + OpenRouter live)

Hybrid AI harness: **TS+Bun core** orchestrates, **Python workers** specialize via MCP.
Full plan: `../docs/04-combination-build-plan.md`. Keys/router: `../docs/05-byok-router-and-keys.md`. Classes: `../docs/06-class-based-architecture.md`.

## Layout
```
harness/
  CLAUDE.md agent.config.json mcp.json package.json tsconfig.json
  src/ cli.ts (CliApp) agent.ts (Agent) renderer.ts (ConsoleRenderer)
       router.ts (ModelRouter) container.ts (ServiceContainer) types.ts (shared)
       router/ providers.ts (ProviderCatalog) keystore.ts (Keystore) bedrock.ts (BedrockClient)
               openrouter.ts (OpenRouterClient) model-catalog.ts (curated pricing) envfile.ts (.env upsert)
               types.ts (router slice)
       hooks.ts (HookManager) subagents.ts (SubAgentManager) observability.ts (RunLogger)
              observability/pricing.ts (cost estimates)
       tools/ tool.ts (BaseTool/ToolRegistry) read.ts write.ts edit.ts glob.ts grep.ts shell.ts
              types.ts (tool args)
       memory/ session.ts (SessionStore) compaction.ts (Compactor) types.ts (SessionTurn)
       __tests__/ + router/__tests__/ + tools/__tests__/ + memory/__tests__/
         (90 tests: compat + class-level, all offline except stubbed live paths)
  python-workers/ rag_server.py eval_server.py tests/
  skills/ coding/SKILL.md rag-expert/SKILL.md
  work/ sessions/<id>.jsonl + <id>.md (one per launch, gitignored)
        session.jsonl runs.jsonl (legacy, gitignored)
```

## Run
```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun install
cp .env.example .env   # add AWS_BEARER_TOKEN_BEDROCK + BEDROCK_REGION
bun run start                       # chat REPL (new session file per launch)
bun run start -- -p "hello"         # one-shot, own session file
bun run start -- --resume -p "hi"   # continue latest session
bun run start -- -p "/model"        # offline route check — no spend
bun run typecheck && bun test
cd python-workers && uv sync && uv run pytest
```
Chat commands: `/model /keys /providers /add-key /models /use /setup /new /resume /sessions /export /exit`. Provider flow:
`/providers` lists with key status, `/add-key <provider> <key>` stores (never echoed, saved to `.env`),
`/models [provider|all]` shows live OpenRouter pricing when keyed else curated, `/use <n|slug>` switches
(`AGENT_MODEL` persisted to `.env`), `/setup` runs the guided wizard. Resume an ended chat with
`bun run start -- --resume` (latest), `--session <id>`, or in-chat `/resume [id]` (bad ids now get a friendly hint, not a stack trace).
Everything stays local — sessions, transcripts, and logs are gitignored, keys never leave `.env`.

Wiring lives in `ServiceContainer.create(env)` — add providers/tools/memory backends there.

## Next (Phase 1)
- Tool-calling loop in src/agent.ts (Bedrock Converse toolConfig + OpenRouter tools; tools already LangChain-ready via tools/langchain.ts)
- Direct-provider live paths (anthropic/openai/google/...) — currently OpenRouter covers them via aggregator
- Copy `.env.example` → `.env`, or just /add-key inside the REPL
