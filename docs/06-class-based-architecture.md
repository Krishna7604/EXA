# Class-Based Modular Architecture (v0.4.0)

Date: 2026-09-23
Status: implemented in `harness/` — 53 bun tests green, typecheck clean, live Bedrock verified.

## Why

Function modules didn't scale: adding a provider, tool, or memory backend meant
touching shared globals. Every unit is now a class with constructor-injected
deps, and `src/container.ts` (`ServiceContainer.create()`) is the single
composition root — future changes happen there.

## Diagram

```
CliApp (cli.ts)
  └─ ServiceContainer.create(env)          ← change wiring HERE
       ├─ ProviderCatalog                 ← provider list (add one = 1 entry)
       ├─ Keystore(env, catalog)          ← keys, presence, redact
       ├─ BedrockClient(keystore)         ← Converse (bearer / SigV4)
       ├─ ModelRouter(catalog,keystore,bedrock,config)
       ├─ SessionStore(file) + Compactor  ← memory
       ├─ ToolRegistry[Read,Write,Edit,Glob,Grep,Shell(hooks)]
       ├─ HookManager / SubAgentManager
       ├─ ConsoleRenderer / RunLogger(keystore)
       └─ Agent(config,router,session,bedrock,renderer,logger)
            └─ historyToMessages()        ← pure, starts with user (Bedrock rule)
```

Python workers unchanged: stateless MCP tools (`rag_search`, `rerank`).

## Class map

| Class | File | Deps in | Notes |
|---|---|---|---|
| `ProviderCatalog` | `router/providers.ts` | — | `prefixOf`, `directProviderFor`, `getProvider` |
| `Keystore` | `router/keystore.ts` | env, catalog | `hasKey/requireKey/keyStatus/redact`, `bedrockAuth/Region` |
| `BedrockClient` | `router/bedrock.ts` | keystore | `endpoint`, `buildConverseBody`, `converse` |
| `ModelRouter` | `router.ts` | catalog, keystore, bedrock, config | `resolveRoute/routeChain/pickModel/shouldRetry/describeRoute` |
| `BaseTool` / `ToolRegistry` | `tools/tool.ts` | — | `register/get/require/run` |
| `Read/Write/Edit/Glob/Grep/ShellTool` | `tools/*.ts` | hooks (shell) | arg validation at edge; `shellTool` singleton for compat |
| `SessionStore` | `memory/session.ts` | file | `appendTurn/loadSession`, `setFile` repoints at another session |
| `SessionManager` | `memory/sessions.ts` | dir | one file per session in `work/sessions/` — `create/info/list/latest` |
| `Compactor` | `memory/compaction.ts` | threshold | `shouldCompact/compact` (LLM summarize = Phase 4) |
| `HookManager` | `hooks.ts` | — | blocklist + `ask-human` for shell |
| `SubAgentManager` | `subagents.ts` | — | stubbed, Phase 4 |
| `ConsoleRenderer` | `renderer.ts` | — | exa-branded chat blocks (`You`/`exa`), big `EXA_LOGO` banner, tokens/cost right, `welcome` + `chatPrompt`; auto no-color when piped |
| `RunLogger` | `observability.ts` | keystore | redacted `runs.jsonl`, now incl. tokens + cost |
| `priceFor/estimateTokens` | `observability/pricing.ts` | — | approximate $/1M table (~ prefix), unknown → tokens only |
| `Agent` | `agent.ts` | config, router, session, bedrock, renderer, logger | single-shot Converse; tool loop = Phase 1 |
| `CliApp` | `cli.ts` | agent, router, keystore, config, sessions, session, renderer | chat REPL (`exa ›` prompt, Tab completes `/model /keys /new /resume /sessions /export /exit /quit`) + one-shot `-p`; replays old turns on open; runs only under `import.meta.main` |
| `ServiceContainer` | `container.ts` | env | THE wiring file |

Types/interfaces live apart from logic, one file per folder (import with
`import type` — zero runtime coupling):

| Types file | Holds |
|---|---|
| `router/types.ts` | `ProviderId/Def`, `BedrockAuth`, `ChatMsg`, `ConverseBody`, `Strategy`, `ResolvedRoute`, `RouterConfig` |
| `tools/types.ts` | `Read/Write/Edit/Glob/Grep/ShellArgs` |
| `memory/types.ts` | `SessionTurn`, `SessionInfo` |
| `src/types.ts` | `Item`, `Verdict`, `SubAgentResult`, `AgentConfig/Deps`, `HarnessConfig`, `CliDeps`, `RunEntry`, `MessageMeta` |

## Compatibility

Legacy function exports (`resolveRoute`, `bedrockConverse`, `appendTurn`,
`render`, `runAgent`, …) stay as thin wrappers over default singletons, so the
original `router.test.ts` passes unchanged.

## How to extend

- New provider: 1 entry in `PROVIDERS` + env var — catalog/router need no edits.
- New tool: `class XTool extends BaseTool<Args, Result>`, register in
  `ServiceContainer.create()` (and `tools/index.ts` for the compat list).
- Swap memory: `new SessionStore(otherFile)` or a new store class behind the
  same two methods; rewire in `container.ts` only.
- Tests: `new Keystore(fakeEnv)` / `ServiceContainer.create(fakeEnv)` — no
  `process.env` mutation, no disk writes (temp files), no network.

## Tests (77, all in per-folder `__tests__/`)

- `router/__tests__/router.test.ts` — legacy API compat (13, untouched)
- `router/__tests__/classes.test.ts` — catalog/keystore/client/router via injection
- `tools/__tests__/tools.test.ts` — registry, all 6 tools, hooks (isolated tmpdirs)
- `memory/__tests__/memory.test.ts` — session roundtrip, compaction threshold
- `__tests__/container.test.ts` — full graph from fake env, env isolation
- `__tests__/agent.test.ts` — openrouter stub path + `historyToMessages` regression
- `__tests__/cli.test.ts` — `/model` + `/keys` offline, values never printed
- `__tests__/chat.test.ts` — `execCommand` without TTY (`/new` switches files, `/sessions` lists newest-first, resume replays old chat, `/resume` by id/latest/bad id, `/export` transcript)
- `__tests__/renderer.test.ts` — chat blocks, right-side meta, width cap, compat entry, brand/banner/prompt, logo alignment
- `__tests__/cli.test.ts` — `/model` + `/keys` offline, values never printed; `completeSlash` Tab behavior
- `__tests__/pricing.test.ts` — family math, unknown → null, ~$ formatting
- `memory/__tests__/sessions.test.ts` — create/list/latest/info in a tmpdir
- `tools/__tests__/langchain.test.ts` — StructuredTool adapter parity (invoke, schemas, hooks)

## LangChain adoption (TS, not a shift)

`@langchain/core` + `zod` are deps; our classes stay the source of truth.
`tools/langchain.ts` translates them (`toStructuredTool`, `langchainTools()`,
`TOOL_SCHEMAS`) so a future LangGraph loop can call them with zero behavior
change. Router, keys, redaction, and approvals stay outside LangChain — it
calls *through* our stack, never around it.

## Bug fixed along the way

`historyToMessages` sliced the last 20 turns without anchoring: once the
session grew past 20 turns starting mid-exchange, Converse rejected with 400
"must start with a user message". Now leading non-user turns are dropped
(`agent.ts`), covered by a regression test. Live `hello` re-verified after.

## Chat + sessions (2026-09-24)

No more one-shot-only: `bun run start` on a TTY (or `--chat`) opens a REPL
(`exa[<id>]>`) sharing one session file for the whole conversation.
`SessionManager` (`memory/sessions.ts`) creates `work/sessions/<id>.jsonl` per
launch — `/new` starts another, `--resume`/`--session <id>` pick up an old one,
`/export` writes `<id>.md` beside it. Opening a session with prior turns replays
them (`--- replaying N earlier turns ---`, user + `exa` blocks with stored
model/ms) before going live. All local: `.gitignore` covers
`harness/work/sessions/`, `runs.jsonl`, `session.jsonl`, `.env`.

## Chat look + cost sidebar (2026-09-24)

Messages render as blocks: `You` / `Agent · <model>` left, usage right —
prompts show `~N tok` (chars/4 estimate), responses show real Bedrock Converse
`usage` (`1,204 in · 86 out · ~$0.0001 · 1.6s`). Costs come from an approximate
$/1M family table (`observability/pricing.ts`, ~ prefix, verify vs AWS pricing);
unknown models show tokens with `—`. Tokens + cost also persist into
`runs.jsonl`. Colors disable automatically when piped or `NO_COLOR` is set.
