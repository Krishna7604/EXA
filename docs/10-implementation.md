# exa v2: as built

Date: 2026-10-10. This describes what is implemented, how the pieces connect, and what is verified. The plans are in docs 07, 08 and 09; this doc records where the build differs from them.

## 1. Shape

```
             ┌──────────── heavy client (apps/cli) ────────────┐      ┌─ light client (apps/web) ─┐
             │ AgentLoop (packages/core)                        │      │ static UI, fetch + SSE    │
             │  tools: local fs/bash/grep/glob/apply_patch/MCP  │      └────────────┬──────────────┘
             │  store: JSONL (local) | memory (none) | mirror   │                   │
             │  approvals: terminal ⟷ race ⟷ remote replies     │                   │
             └───────┬──────────────┬───────────────┬───────────┘                   │
     /v1/model/stream│   /v1/authorize│  /ingest + /lease│ /events (SSE)               │
                     ▼              ▼               ▼                               ▼
             ┌──────────────────────── exa server (apps/server) ─────────────────────────┐
             │ auth (JWT · API tokens · device code · OIDC) · rate limits · CORS/CSP      │
             │ gateway ─► exa router (tiers, health, fallback) ─► provider adapters        │
             │ policy: signed bundles (Ed25519) · authorize (locked rules + risk classifier)│
             │ server loop runtime: same AgentLoop, sandbox workspace (+ docker shell)      │
             │ approval broker (first answer wins) · event bus (seq, ring buffer, resume)   │
             └───────────────┬───────────────────────────────────────────────────────────┘
                             ▼
                 Postgres (or embedded PGlite): RLS on every tenant table
```

## 2. The loop: one implementation, two hosts

`packages/core/src/loop/` holds the only agent loop (`agent-loop.ts` is the entry, `step-runner.ts` runs one model step). Everything it needs comes in through ports (`ModelPort`, `SessionStore`, `EventSink`, `ToolRegistry`, permissions, snapshots, instructions, skills). The server passes in its gateway, a per-tenant `ServerSessionStore` and the sandbox. The CLI passes in an HTTP model client, JSONL/memory/mirror storage and local tools.

Loop behaviour:
- **Model calls:** streaming with deltas, and retry of retryable errors before any output.
- **Tool execution:** read-only tools in one step run in parallel; others run one at a time. Tools whose permission is fully denied are hidden from the model.
- **Guards:**
  - **Doom-loop:** the third identical call triggers a `doom_loop` approval.
  - **Step and cost caps:** the last step runs without tools and with a summarize instruction.
  - **Abort:** everything stops on the session's AbortSignal.
- **Context management:**
  - **Auto-compaction:** the latest user turn and the carried file list stay verbatim.
  - **Revert/unrevert:** restores both the snapshots and the conversation.
- **Subagents:** the `task` tool runs a subagent in a child session, with a depth limit. Subagents run on the fast tier under `exa`.
- **Writes:** parts are written once per step, in their final state; deltas are only sent as events. This is what keeps database load low.

## 3. Permissions

- **Rule order:** builtin < tenant < project < user < agent < session (mode and "always" answers). The last match wins.
- **Locked rules:** locked rules (the builtin secret floor and locked tenant rules) are evaluated after everything else and always win.
- **Bypass mode:** `bypass` turns `ask` into `allow`, but never overrides `deny` or a locked rule.
- **Bash:** each command is split into its sub-commands, including `$( )`, backticks, subshells and redirections. Redirect targets need `edit` permission. Path arguments outside the root need `external_directory`.
- **Paths:** paths are resolved through `realpath`, so a symlink can't escape the workspace.
- **Client loop:** the client enforces a bundle signed by the server. The client pins the server's key at login (trust on first use) and refuses to run on a signature mismatch. For keys listed in `serverChecked` (default `bash`, `external_directory`), it also calls `/v1/authorize`. The server checks only what the client can't be trusted with: locked org rules and the command risk classifier (`curl|sh`, `rm -rf /`, credential reads, force-push, infrastructure deletes). If the authorize call fails, the action becomes `ask`.

## 4. Data (Postgres)

- **Access:** repositories use the **Drizzle ORM** (0.45). `db.orm` runs as the owner (system queries); inside `db.withTenant(tenant, (q) => …)` the handle `q.orm` is bound to that transaction, so ORM queries run under RLS as `exa_app`. Drizzle tables live in `packages/store/src/tables/` and are checked against the migrated schema by `tables.test.ts`. Custom `jsonb`/`bytea` column types keep Bun SQL and PGlite identical (Drizzle's own `jsonb` double-encodes on Bun SQL).
- **Migrations:** `packages/store/src/migrations/schema.migrations.ts` (hand-written SQL: RLS policies and partitions are beyond an ORM's migration generator). `003_personal_agent` adds `memories` (generated tsvector + GIN), `scheduled_tasks`, `task_runs`, `sessions.task_id`, connector timestamps and a GIN index for chat search over stored text parts.
- **Global tables:** tenants, users, memberships, api_tokens (hashed), device_codes, model_backends.
- **Tenant tables:** every tenant table has RLS keyed on `exa.tenant_id`, enforced by switching to the `exa_app` role with `SET LOCAL ROLE`.
- **Content tables:** `messages`/`parts` exist for sessions with `storage_mode='server'`, which is now the default for every session (web and CLI). Content is kept forever unless an org sets `retention.contentDays`; the maintenance job enforces it.
- **High-volume tables:** `usage_events` and `audit_log` are append-only and partitioned by month. Old months are dropped as whole partitions. `usage_rollups` back the quota checks.
- **Driver portability:** JSON and array parameters are always sent as text and cast in SQL, so Bun's Postgres driver and PGlite behave the same way. Both are tested.

## 5. Models

- **Adapters:** OpenAI-compatible (OpenAI, OpenRouter, Groq, Gemini, DeepSeek, xAI, Mistral, Together, Cerebras, OpenCode Zen, Ollama), Anthropic (with prompt-cache breakpoints) and Bedrock ConverseStream (a bearer key or our own SigV4, which matches the AWS test vector; an event-stream decoder; cache points on supported models).
- **`exa` model:**
  - **Tier choice:** a cheap classifier picks the tier.
  - **Candidate filter:** backends must have credentials, support tool calls when needed, and have enough context room.
  - **Ordering and failover:** backends are ordered by circuit-breaker state, priority and latency (EWMA). On a failure before the first output token, the router falls back to the next backend.
- **BYOK lookup order:** user key → org key → pool (the pool only if `pool.forDirect` is enabled).
- **Usage:** usage and cost are recorded for every call. A provider-reported cost wins over the price table.

## 6. Verification

- **Tests:** `bun run check` runs the typecheck plus 100 tests on embedded Postgres. `bun run test:pg` runs the store and server suites against real Postgres 16, and all pass there too.
- **Live checks, 2026-10-10:**
  - **Model path:** OpenRouter streaming with tool calls.
  - **Heavy client:** fixed a bug locally and through the server. The server stored the messages and recorded usage and the audit trail.
  - **Light client:** an approval was answered over HTTP and the file was written in the sandbox.
  - **Compiled binary:** fixed a bug with `apply_patch`.
  - **MCP:** connected to the real Python FastMCP RAG worker.
  - **Docker sandbox:** no network, read-only root, non-root user, timeouts enforced.
- **Not verified live:** Bedrock (the bearer token in `harness/.env` has expired; the adapter is unit-tested), OIDC against a real IdP (verified with locally signed RS256 tokens), and the web UI in a real browser (the browser extension was unavailable; the page, its CSP and the exact API calls it makes were verified).

## 7. Multi-node and limits

- **Running several server nodes:**
  - **Already shared through Postgres:** leases, approvals, sessions, usage and audit all live in the database, so any node can serve the API.
  - **Approval waiters:** a node waiting on an approval also polls the database, so an answer recorded on another node still releases the waiting loop.
  - **Live event streams are per node:** route a session's traffic to one node (sticky by session id in the URL path) so its viewers and its loop share an event bus. Postgres LISTEN/NOTIFY fan-out is the next step if sticky routing is not possible.
- **Large tool sets:** when there are more than 20 MCP tools (`deferThreshold`), they are sent as names only. The model loads schemas on demand with `tool_search`.
- **Org-shared skills and agents:** `/v1/skills` and `/v1/agents` (tenant scope is admin-only) feed both server-loop chats and the CLI. Local definitions win on a name clash.
- **`webfetch`:** it resolves DNS and re-checks every redirect hop against private/link-local/CGNAT ranges. DNS-rebinding between the check and the connect is not covered; put an egress proxy in front of production sandboxes.
- **Rate limits:** API calls are limited to 600/min per user. Live sync (ingest, SSE, model stream, authorize) has its own budget of 6000/min.
- **Open:**
  - **Notifications:** scheduled-task results are only in the app (no email/push/webhook yet).
  - **Connectors:** static headers only; remote MCP OAuth (dynamic client registration) is next.
  - **Web UI:** diff view and syntax highlighting; usage charts.

## 8. Personal agent (2026-11-06)

See [`docs/13`](13-personal-agent.md). In short: the `assistant` agent is the default; the server runtime gives every web chat the user's memory (`memoryFor`), web search (`search`) and connectors (`connectorsFor`); `runtime.run()` lets the scheduler run a prompt to completion; scheduled sessions (`taskId` set) get an approval port that denies instead of waiting. The web app was rebuilt (Iris design, still no build step) and checked in headless Chrome against a live server: sign-in, chat with memory + web search + approvals, chat search, tasks, memory, tools, settings, dark mode and a phone-width layout.
