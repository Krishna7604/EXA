# exa as a personal agent

Date: 2026-11-06. This doc covers three things: a review of the architecture as it stood, what was changed to turn the coding harness into a personal agent, and what is still missing compared with similar products.

## 1. Review: what was already right

The v2 architecture is a good base for a general agent. Most of it needed no structural change:

- **One loop, injected ports.** `packages/core` knows nothing about where it runs. Model, storage, events, tools, permissions, instructions and skills are all ports. That is why memory and web search could be added as two new optional ports (`MemoryPort`, `SearchPort`) without touching the step runner's logic.
- **Layered server.** Each feature in this round slotted into the same controller → service → repository → model shape, so the four features were built in parallel without collisions.
- **Safety model.** The permission engine, locked org rules, the approvals broker (any client can answer) and RLS on every tenant table carry over to non-coding work as they are. Sending, posting and deleting are exactly the actions a personal agent must ask about.
- **Router and BYOK.** The `exa` tiered router with fallback and the envelope-encrypted key vault were reused as-is. Connector secrets are stored with the same vault.

What held it back:

| Problem | Effect |
|---|---|
| The only primary agent was a software-engineering prompt (`build`) | Every chat was framed as coding |
| `storage.mode` defaulted to `none` for web chats; content retention was 30 days | Chats vanished after a runtime restart or a month; no history to search |
| No long-term memory | Users repeated themselves every chat |
| No scheduler | The agent could only work while someone was typing |
| `webfetch` only, no search | The agent couldn't find anything it didn't already have a URL for |
| `mcp_servers` table existed but nothing used it server-side | Web chats couldn't reach any of the user's apps |
| Raw SQL strings in 15 repositories, rows typed `any` | No compile-time check that a query matches the schema |

## 2. What changed

| Area | Change |
|---|---|
| Default agent | New `assistant` agent (general personal agent; codes when it has a workspace). `build` stays as the coding specialist. Server and CLI both default to `assistant`. |
| Storage | `storage.mode` defaults to `server` for every session (web and CLI); `retention.contentDays` defaults to `0` (keep forever). Orgs can still choose otherwise and lock it. |
| ORM | Every repository uses the **Drizzle** query builder. `Db` exposes `orm`, and every transaction handle carries an ORM bound to that connection, so RLS (`withTenant`) applies to ORM queries unchanged. Two queries that call plpgsql partition functions stay raw, with a comment. A test checks every Drizzle table against the migrated schema on both drivers. |
| Memory | `memories` table (topic + content, generated tsvector, GIN). Tools `memory_save` / `memory_forget` / `recall`. Up to 60 memories (≤6 000 chars) go into a `<memory>` block in the system prompt each turn. API `/v1/memories`, full-text chat search at `/v1/search`. The CLI uses it over HTTP when logged in. |
| Scheduled tasks | `scheduled_tasks` + `task_runs`. Cron schedules with IANA time zones (croner 10.0.1). A per-node scheduler claims due tasks with `FOR UPDATE SKIP LOCKED`; missed runs collapse into one. Each run is a stored chat (`sessions.task_id`). Actions that need approval are **denied with a reason** (the agent carries on and reports what it couldn't do) instead of waiting for nobody. API `/v1/tasks`. |
| Web search | `websearch` tool behind `SearchPort`: Tavily, Brave or self-hosted SearXNG when configured, otherwise a best-effort keyless DuckDuckGo fallback. Same env vars for server and CLI. |
| Connectors | Server-side remote MCP (HTTPS only; private hosts only with `EXA_CONNECTORS_ALLOW_PRIVATE=1`; no redirects). Header secrets sealed with the BYOK vault, never returned or logged. Connected per live chat, 10 s connect deadline, one broken connector never breaks the others. Tools ask before running (`mcp` permission). API `/v1/connectors`. |
| Web app | Rebuilt in the Iris design: icon rail (Chats, Tasks, Memory, Tools, Settings), chat list grouped by day with full-text search, a home screen with suggestions and upcoming task runs, agent activity as a plain-language trail, marigold approval cards, light/dark/system themes, phone layout with a bottom tab bar. Still no build step; fonts are self-hosted so the strict CSP is unchanged. |

### Request flows

**A web chat turn.** `POST /v1/sessions/:id/prompt` → `ServerRuntime.liveFor` builds (or reuses) the session's loop with `memoryFor(tenant, user)`, the search port and `connectorsFor(subject)` → the step runner loads instructions, skills and memories → the model sees the `<memory>` block and the tool list (built-ins + connector tools, deferred via `tool_search` above 20) → tool calls pass the permission gate (asks go to the approvals broker, answered from any client) → each finished step is written once to `messages`/`parts` → events stream over SSE.

**A scheduled run.** The scheduler tick claims due rows across tenants (owner connection) → checks the owner is still an active member → creates a server-loop session with `taskId` → `runtime.run()` awaits the turn; the session's approval port denies anything that would ask → the run's status, error and cost go to `task_runs` and the task's `last_*` columns.

## 3. Compared with similar products

Survey of Open WebUI, LibreChat, LobeHub, Khoj, Letta, AnythingLLM, Manus, ChatGPT, Claude, Gemini and Perplexity (late 2026, from their docs):

| Capability | Common in those products | exa now |
|---|---|---|
| Long-term memory with user control | Nearly all; explicit tools + prompt injection is the common design (Open WebUI, Claude, LibreChat) | **Yes** (same design) |
| Scheduled / recurring tasks | ChatGPT, Gemini, Perplexity, Manus, Open WebUI, Khoj, AnythingLLM, Letta | **Yes** |
| Web search with citations | All | **Yes** (pluggable providers) |
| Connectors via MCP | Claude, ChatGPT, Open WebUI, LibreChat, LobeHub, Manus | **Yes**, static headers; no OAuth yet |
| History search, plus a recall tool for the agent | Claude, ChatGPT, LibreChat | **Yes** |
| Notifications for background results (email, push, webhook) | ChatGPT, Khoj, Manus, Open WebUI | No |
| Files + knowledge bases (RAG) | Most | No |
| Projects (instructions + files + scoped memory) | ChatGPT, Claude, Gemini Gems, Perplexity | Table exists (`projects`), no UI |
| Research mode (planner + parallel subagents + cited report) | Claude, ChatGPT, Khoj, Manus | Partly (subagents exist; no dedicated mode) |
| Artifacts / canvas | Claude, LibreChat, LobeHub | No |
| Voice | Open WebUI, ChatGPT, Gemini, Khoj | No |

## 4. Roadmap, by value for effort

1. **Notifications** for task results and long runs: a webhook per task first (one POST), then email via SMTP. Scheduled tasks are much more useful when results arrive without opening the app.
2. **Pre-approved tools per task.** Let a task carry allow rules (e.g. `mcp gmail/*`, `webfetch *`), so unattended runs can use connectors. Today they are denied by design.
3. **Connector OAuth** (remote MCP authorization with dynamic client registration), so Gmail, Calendar and Drive connect without hand-made tokens.
4. **Projects with files**: upload → chunk → embed (pgvector) + hybrid search with the existing tsvector; project instructions and project-scoped memory.
5. **Research mode**: a `research` agent that plans, fans out `explore`-style web subagents and writes a cited report.
6. **Multi-node live events**: Postgres LISTEN/NOTIFY fan-out (still open from docs/10).

## 5. Known limits of this round

- The memory cap (500 per user) is checked before insert, so two saves at the same instant can go one over.
- Memories saved from the CLI have no source chat (the HTTP body has no `sessionId`).
- A task's model is checked against the org's allowed list when it runs, not when it's saved; `* * * * *` (every minute) is allowed.
- A run left `running` by a server crash stays that way (future runs aren't blocked).
- The keyless search fallback scrapes DuckDuckGo's HTML page and can break or be rate-limited; configure Tavily, Brave or SearXNG for anything serious, or set `EXA_SEARCH_PROVIDER=off`.
- DNS rebinding between the SSRF check and the connection is not covered for connectors (same as `webfetch`); put an egress proxy in front of production.
