# exa v2 — Multi-tenant Server + Heavy/Light Client Plan

Date: 2026-10-10
Status: PLAN (nothing built yet). Based on `How Claude Code Works as a Harness.md` + review of current `harness/`.

## 1. Vision in one paragraph

exa is a **server-side harness** (agent loop, permissions, memory policy, model routing) that many
tenants share. Anything can talk to it through one typed protocol: a **heavy client** (CLI/desktop that
also executes tools on the user's machine) or a **light client** (web/chat UI only; tools run in a server
sandbox). The model users pick is `exa`, a virtual model that orchestrates free/cheap backends, or they
bring their own API key and pick a specific model. Storing chat content is **opt-in config**, never forced.

## 2. Where current code stands (honest gap list)

| Needed (from the Claude Code architecture) | Today in `harness/` |
|---|---|
| Agent loop: send → tool_use → permission → run → tool_result → repeat → stop | **Missing.** `Agent.runAgent` is a single model call; tools are never invoked by the model |
| Tool schemas sent to the model | Missing (only a LangChain adapter exists) |
| Permission pipeline (policy → hooks → rules → mode → ask) | `HookManager` fails open; `ask-human` auto-allows; write/edit skip hooks; no path confinement |
| Streaming | Missing |
| Multi-tenant / auth / DB | Missing (`DATABASE_URL` in `.env`, unused) |
| Server/client split | Everything is one CLI process |
| Compaction, subagents | Stubs |

Reusable as-is: `ServiceContainer` pattern, `ProviderCatalog`, `Keystore` (needs per-tenant version),
`BedrockClient`/`OpenRouterClient`, pricing, `BaseTool`/`ToolRegistry`, renderer. Verdict: **keep the
class/DI style and the router; revamp agent, hooks, session and the process boundary.**

## 3. Core decision: one loop, pluggable executors

Claude Code's rule: *the model only emits requests; the harness decides and runs them.* Extending that:

> The **server owns the agent loop and every permission decision.** Tool calls are dispatched to an
> **Executor**. A heavy client registers itself as the executor for local tools (fs, shell); the server
> sandbox is the executor for light clients.

```
 Light client (web chat)                 Heavy client (CLI/desktop)
   UI only                                 UI + Local Executor (fs, shell, git, MCP stdio)
        \                                   /
         \---- exa protocol (HTTPS + SSE/WebSocket, typed events) ----/
                                |
                       ┌────────▼─────────┐
                       │   exa-server      │  = "server harness"
                       │ auth · tenancy    │
                       │ agent loop        │
                       │ permission engine │  ← authoritative
                       │ model gateway     │  → exa router → free pool / BYOK / Bedrock
                       │ memory policy     │
                       │ audit · usage     │
                       └───┬──────────┬────┘
                    Postgres      Server sandbox executor (light-client tools, MCP remote, RAG/eval workers)
```

Why this over "loop on the client": one permission engine, one place for org policy, light and heavy
clients behave identically, approvals can be answered from any attached UI (phone approves what the
laptop asked). Cost: a network round trip per tool call and heavy client must stay connected. Mitigation:
batch parallel tool calls in one message; offline heavy mode (later phase) = embed the same server
library in-process (the code is the same package, so this is cheap).

## 4. Multi-tenancy model

Entities: `tenant` (org) → `user` (member, role) → `workspace/project` → `session` → `turn`.

- **Auth:** OIDC/OAuth login for humans (light + heavy via device-code flow); scoped API tokens for
  heavy clients; short-lived JWT per connection carrying `tenant_id, user_id, role, client_kind`.
- **Isolation:** every table has `tenant_id`; Postgres Row-Level Security keyed on a session var set per
  request. Server sandbox = per-tenant (ideally per-session) container/microVM, no shared fs, egress
  allowlist. Tenant secrets never leave the key vault path.
- **Roles:** owner, admin, member, viewer. Admin edits policy; member edits own settings within policy.

### Database (Postgres) — minimal by design

```
tenants(id, name, plan, settings jsonb)           -- includes storage_policy, model_policy
users(id, tenant_id, email, role, status)
memberships / api_tokens(id, user_id, hash, scope, expires_at)
projects(id, tenant_id, name, settings jsonb)
sessions(id, tenant_id, user_id, project_id, title?, storage_mode, created_at, last_active_at)
                                                  -- metadata ONLY; no content
turns(id, session_id, parent_id, role, content jsonb, ts)   -- exists ONLY if storage_mode='server'
provider_keys(id, tenant_id, user_id?, provider, ciphertext, key_ref, created_at)  -- BYOK, envelope-encrypted
permission_rules(id, scope[org|project|user], tenant_id, rule, effect[allow|ask|deny], priority)
approvals(id, session_id, tool, args_hash, state, decided_by, ts)   -- pending/decided, short TTL
usage_events(id, tenant_id, user_id, model, in_tok, out_tok, cost_usd, ts)   -- counters, no prompts
audit_log(id, tenant_id, actor, action, target, ts)  -- tool name + decision, NOT args content by default
```

## 5. Chat storage = a config, not a default (your DB-load concern)

Setting `storage_mode`, resolved as **org policy ∩ user preference**:

| Mode | Who writes content | Where | Works for |
|---|---|---|---|
| `none` (default for light) | nobody | memory of the live connection only; gone on disconnect | both |
| `local` | heavy client | `~/.exa/sessions/*.jsonl` on the user's machine (same JSONL shape as today) | heavy only |
| `server` | server | `turns` table (or object storage for big blobs) | both |

Rules:
- The **server always holds only metadata** (session row, usage counters, audit). That is cheap and what
  billing/limits need.
- Org admin can force `server` (compliance), forbid `server` (privacy), or leave it to users.
- Load control for `server`: append-only batched writes (flush every N turns / seconds), content
  compressed, large tool outputs to object storage by reference, partition `turns` by month, retention
  TTL per tenant, and a "forget session" that deletes everywhere in one call.
- Light client in `none` mode keeps context only for the live connection; to survive reload, the
  browser may keep it in IndexedDB (client-side `local` for web) — a later option.
- Context is rebuilt per turn from whichever store is active, then sent through the same prompt-assembly
  code (CLAUDE.md/project instructions + history + tools).

## 6. The `exa` model and BYOK

**`exa`** is a virtual model = an orchestrator in the gateway, not a real model.

1. Classify request cheaply (length, needs-tools, code vs chat, language; later a tiny classifier call).
2. Pick a tier: `fast` (chat/small edits) → `balanced` → `strong` (planning, hard debugging).
3. Each tier is an ordered pool of backends from a registry (config, hot-reloadable): free/open
   sources you have access to (e.g. OpenRouter `:free` models, free-tier Groq/Gemini, OpenCode-style free
   models, Bedrock Nova), plus paid fallbacks.
4. Health: per-backend circuit breaker, latency/error stats, tenant rate limits, retry-then-fallback
   (the `shouldRetry` logic already exists).
5. Tool-call compatibility is a **capability flag per backend**; `exa` only routes tool-using turns to
   backends flagged as reliable at function calling. Normalize tool-call formats in the gateway.
6. Return the real model used in every event (`model: exa → groq/llama-…`) for transparency and usage.

**BYOK:** user (or tenant admin) adds a key per provider → stored envelope-encrypted (data key per
tenant, wrapped by KMS/master key), decrypted only in the gateway at call time, never logged
(`redact()` already exists), never sent to clients. Choosing `openai/gpt-5` etc. uses the user's key and
is billed to them; choosing `exa` uses the platform pool and counts against the tenant's quota. Admin
policy can restrict allowed models/providers or disable BYOK.

Caveat to verify before promising "free": free-tier availability, rate limits and ToS (especially for
commercial multi-tenant use) change. Make the pool config-driven so nothing is hard-wired.

## 7. Permissions and state (server is authoritative)

Same pipeline as Claude Code, evaluated on the server for every tool call, regardless of executor:

1. Org/tenant policy (cannot be overridden)
2. Server-side hooks (PreToolUse: secret scan, command classifier, path rules, quota, tenant allowlists)
3. Rules (deny > ask > allow; scopes org > project > user)
4. Session mode: `default | accept-edits | plan (read-only) | bypass` (bypass only where policy allows,
   sandbox executors only)
5. Human approval → `approvals` row + `approval_request` event to **all attached UIs**; answer once /
   session / always (writes a rule). Pending approvals survive reconnect.
6. Executor-side guardrail (defense in depth): heavy client enforces workspace-root path confinement and
   OS sandbox regardless of what the server says.

Fail closed: if the classifier/hook errors, the result is `ask`, never `allow`.
Session state (mode, pending approvals, in-flight tool calls, attached clients) lives server-side in
memory with Redis (or Postgres) behind it so any server node can resume a session.

## 8. Protocol (the contract both clients speak)

Typed (zod) shared package; transport = HTTPS for commands, SSE or WebSocket for the event stream.

- Client → server: `session.create/resume`, `user.message`, `approval.respond`, `interrupt`,
  `mode.set`, `tool.result` (heavy only), `executor.register {tools, workspace}`.
- Server → client: `text.delta`, `tool.request` (to executor), `tool.status`, `approval.request`,
  `usage`, `compaction`, `error`, `turn.end`.
- Heavy client registers capabilities (`fs`, `shell`, `mcp:<name>`); light client registers none and
  the server maps tools to its sandbox or hides local-only tools from the model.
- Versioned (`protocol: 1`) so old clients keep working.

## 9. Repo layout (monorepo, Bun workspaces)

```
exa/
  packages/
    protocol/     zod schemas + event types (shared)
    core/         agent loop, prompt assembly, compaction, permission engine, hook runner (pure, no IO)
    router/       providers, exa orchestrator, gateway, keystore (tenant-aware)
    tools/        tool definitions + executors (local executor, sandbox executor)
    store/        Storage interface + none/local/server(PG) implementations, Drizzle migrations
  apps/
    server/       Hono API, auth, tenancy/RLS, session runtime, admin API
    cli/          heavy client (Ink/readline TUI + local executor)
    web/          light client (chat UI + approvals + settings + key management)
  workers/        python MCP workers (rag, eval) — stay stateless
  docs/
```

Stack defaults (change if you disagree): Bun + TypeScript, Hono, Postgres + Drizzle, Redis (later),
zod, OIDC (e.g. self-hosted Keycloak/Auth.js/WorkOS), Docker/Firecracker-style sandbox.

## 10. Phases (each has an exit test)

**P0 — Fix the foundation (days).** Resolve review items: fail-closed hooks, route write/edit through
hooks, path confinement, `.env` upsert bug, session corrupt-line handling, redact before persist.
*Exit:* tests prove `rm -fr`, `../` escapes and `.env` reads are blocked/asked.

**P1 — Real agent loop, single process (1–2 wks).** Tool schemas → model, tool_use/tool_result loop,
streaming, parallel tool calls, step/cost limits, permission engine with modes, compaction (LLM
summary), `Storage` interface with `none`/`local` impls. Move to `packages/core`.
*Exit:* "find where X is defined and fix it" works end-to-end on Bedrock + OpenRouter.

**P2 — Split server and client (1–2 wks).** `protocol` package, `apps/server` running the loop,
`apps/cli` as heavy client with local executor; in-memory tenancy (one hard-coded tenant), approvals
over the wire.
*Exit:* CLI on laptop A drives a server on box B; approval answered correctly; tool runs locally.

**P3 — Multi-tenant + DB (2 wks).** Postgres schema + RLS, auth (device-code for CLI, OIDC for web),
roles, `server` storage mode, tenant/user settings, usage + audit tables, rule storage.
*Exit:* two tenants cannot see each other's data (automated cross-tenant test); storage mode matrix
verified (none writes zero turns rows).

**P4 — Model gateway + `exa` + BYOK (1–2 wks).** Tenant-aware keystore with envelope encryption,
backend registry, tiers, circuit breaker, quotas, tool-capability flags, admin model policy.
*Exit:* `exa` survives a backend outage via fallback; BYOK key never appears in logs/DB plaintext.

**P5 — Light client + server sandbox (2 wks).** Web chat UI, approval UI, settings/keys UI, per-session
sandbox executor, remote MCP, RAG worker wired as tools.
*Exit:* a browser-only user completes a task using sandbox tools; same session visible/approvable from
two clients.

**P6 — Hardening and extensibility.** Subagents (own context, sidechain records), skills/CLAUDE.md per
project, plugin/MCP management per tenant, secret scrubbing on tool output, "forget session", retention
jobs, rate limiting, observability (OpenTelemetry), load test.

## 11. Decisions I need from you (my defaults in bold)

1. Loop location: **server-owned loop + executors** (section 3) vs loop on heavy client with server as
   gateway only. The second is simpler for P2 but you lose uniform permissions and light-client parity.
2. Hosting target: **self-hosted single region (Docker + Postgres)** vs cloud-managed.
3. Auth provider: **OIDC via an off-the-shelf provider** vs building accounts yourself (don't).
4. Sandbox tech for light clients: **containers per tenant first, microVMs later**.
5. Is `exa` free-pool for all tenants, or plan-gated? **Quota per tenant, free pool on all plans.**
6. Keep Python workers as separate MCP services? **Yes.**
7. Greenfield monorepo, porting the good classes over, vs in-place refactor? **Monorepo + port.**

## 12. Main risks

- **Round-trip latency** of server-owned loop with remote executors → batch tool calls, stream early.
- **Free-model tool-calling quality** varies a lot → capability flags + eval harness (your `eval_server`)
  gating which backends may serve tool turns.
- **Sandbox escape / noisy neighbors** in light mode → start with no-network, tight quotas.
- **Key custody** is the highest-impact security surface → KMS, no plaintext at rest, audit every use.
- **Scope**: P0–P2 give a usable product; P3+ is where multi-tenant cost lives. Don't start P3 before P1's
  loop is solid.
