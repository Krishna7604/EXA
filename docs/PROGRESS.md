# exa v2 build progress

Plan: docs/07 (phases), 08 (dual loop + DB), 09 (OpenCode lessons). As built: docs/10. Legacy v1 lives in `harness/` (untouched).

Run everything: `bun run check` (typecheck + tests) · real Postgres: `bun run test:pg`.

| Phase | Item | Status |
|---|---|---|
| P0 | Fail-closed permission engine, locked secret floor, path confinement incl. symlinks, parsed-bash matching | done |
| P1 | `@exa/protocol` | done |
| P1 | `@exa/core`: loop (streaming, parallel read-only tools, doom-loop, caps, retry, abort, compaction, revert, subagents) | done |
| P1 | `@exa/tools`: fs/search/bash/web/todo/skill/question/apply_patch, read-before-write guard, truncation, shadow-git undo, AGENTS.md/skills/agents/commands discovery, MCP (stdio + HTTP) | done |
| P2 | `apps/server`: HTTP + SSE (resume), auth, sessions, leases, ingest, gateway, authorize, signed policy, server loop, approvals broker, docker sandbox | done |
| P2 | `apps/cli`: client loop, server sync (lease, batched ingest, mirror storage), terminal approvals racing remote replies, local mode, slash + custom commands, compiled binary | done |
| P3 | `@exa/store`: Postgres + PGlite, RLS, partitions, identity, settings, rules, BYOK, quotas, leases, approvals, telemetry, storage modes | done (both drivers tested) |
| P4 | `@exa/router`: OpenAI-compatible/Anthropic/Bedrock adapters, `exa` tiered router + breaker, vault, gateway | done |
| P5 | `apps/web`: login, device approval, chat (server loop), live viewer/approver for CLI sessions, settings, BYOK, usage, org policy | done (not browser-tested) |
| P6 | OIDC, rate limits, retention/maintenance, forget, audit, Dockerfile + compose, README | done |
| P6+ | org skills/agents API, deferred tool schemas (tool_search), approval polling for multi-node, SSRF DNS guard, sync rate-limit budget, pre-run compaction, approval cross-session fix | done |
| P7 | Personal agent: `assistant` default agent, every chat stored by default (kept forever), Drizzle ORM in all repositories, long-term memory + chat search, scheduled tasks, web search, server-side MCP connectors, Iris web redesign (browser-tested) | done (docs/13) |
| next | event fan-out across nodes (LISTEN/NOTIFY), notifications for task results, OAuth for connectors, files + knowledge (RAG), voice | open |
