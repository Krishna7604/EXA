# exa

A self-hosted, multi-tenant **personal AI agent**. It researches, writes, plans and handles everyday work; it remembers what you tell it, runs recurring tasks on a schedule, uses the apps you connect, and — given a workspace — writes code. One agent loop, two places to run it:

- **Web app** (light client): the loop runs on the server. Chats get web search and page reading, long-term memory, plans (todos), skills, helper subagents and your connectors — but **no filesystem** by default. Set the org's `web.tools` setting to `agent` to add files and code in a per-chat sandbox.
- **CLI** (heavy client, `exa`): the loop runs on your machine, tools act on your files, and the server provides models, policy, approvals, memory, audit and chat storage.

Every chat and every message is stored in Postgres by default and kept until you delete it (orgs can change both). The design for the personal-agent features is in [`docs/13`](docs/13-personal-agent.md).

Both kinds of client use the same protocol, the same permission engine and the same `exa` model router. Design docs are in [`docs/07`](docs/07-multitenant-server-client-plan.md), [`docs/08`](docs/08-dual-loop-and-db-architecture.md) and [`docs/09`](docs/09-opencode-lessons.md). The as-built architecture is in [`docs/10`](docs/10-implementation.md).

## Quick start (single machine, no Postgres)

```bash
bun install

# 1. server: dev login on, provider keys read from harness/.env (or EXA_KEYS_FILE=path),
#    embedded Postgres in ~/.exa/server
bun run dev
#    → http://127.0.0.1:4317  (web client)

# 2. CLI: install the `exa` command, log in, then work in any repo
bun run build:cli && cp dist/exa /usr/local/bin/exa     # or: (cd apps/cli && bun link)
exa login --dev --email you@company.dev --tenant acme
cd ~/code/my-repo && exa
```

You can also run with no server at all, using your own keys:

```bash
exa --local --env-file ~/.exa/keys.env -m openrouter/anthropic/claude-sonnet-4.5
```

## Postgres in Docker (development)

`bun run dev` uses an embedded Postgres (PGlite) stored in `~/.exa/server/pg`. To develop against real Postgres in Docker instead:

```bash
bun run db:up        # start dev Postgres (127.0.0.1:54320) + test Postgres (127.0.0.1:55432)
bun run dev:pg       # run the server against the Docker dev database
bun run test:pg      # run the store + server tests against the Docker test database
bun run db:psql      # open psql on the dev database
bun run db:down      # stop the containers (dev data is kept in the exa-dev-pgdata volume)
bun run db:reset     # stop and DELETE the dev data
```

The dev database keeps its data in a Docker volume. The test database lives in RAM and is wiped when it stops. To use any other Postgres, set `DATABASE_URL`. Migrations run automatically when the server starts.

## Production

```bash
cp .env.example .env      # set EXA_JWT_SECRET, EXA_MASTER_KEY, OIDC, pool keys
docker compose up -d      # exa server + Postgres 16
```

- **Auth:** OIDC SSO (`EXA_OIDC_*`) for the web; device-code login for the CLI (`exa login --server https://exa.company.com`). Dev login is off unless `EXA_DEV_AUTH=1`.
- **Isolation:** every tenant table has Postgres row-level security. The app runs tenant queries as the non-owner `exa_app` role.
- **Light-client shell:** with `web.tools = "agent"`, `EXA_SANDBOX_SHELL=docker` gives each server-loop chat a container. It has no network, a read-only root, runs as non-root, and has CPU/memory/pids limits. Without it, those chats get file tools but no shell.

## Concepts

| | |
|---|---|
| **Models** | `exa` (auto tier) or `exa/fast`, `exa/balanced`, `exa/strong` use the org pool, with health-aware fallback across backends. `provider/model` (e.g. `openai/gpt-5`) uses your key (BYOK), and falls back to the pool if the org allows it. |
| **BYOK** | Keys are envelope-encrypted (AES-256-GCM, a data key per secret, master-key versions for rotation). They are decrypted only in the gateway at call time and never returned or logged. |
| **Chat storage** | `server` (the default) stores every chat and message in Postgres, kept forever unless the org sets `retention.contentDays`. `local` keeps CLI chats on your device in `~/.exa/sessions` (append-only, 0600); `none` keeps content in memory only. Admins can lock the mode. Session metadata, usage and audit are always kept. |
| **Agents** | `assistant` (default) is a general personal agent; `build` is the coding specialist; `plan`, `explore` and `general` are read-only/subagent helpers. Pick with `/agent` in the CLI. |
| **Memory** | The agent saves lasting facts and preferences with `memory_save` and sees them at the start of every turn; `recall` searches memories and past chats (Postgres full-text). You can view, edit and delete everything on the web Memory page. |
| **Scheduled tasks** | A prompt plus a cron schedule and time zone. The server runs it as you, each run becomes a chat, and actions that need approval are denied (with the reason) rather than left waiting. Multi-node safe (`FOR UPDATE SKIP LOCKED`). |
| **Web search** | `websearch` uses Tavily, Brave or a self-hosted SearXNG when configured, otherwise a best-effort keyless fallback; `webfetch` reads pages (asks first). |
| **Connectors** | Remote MCP servers (HTTPS) added per user or per org on the web Tools page. Secret headers are encrypted with the BYOK vault and never returned; connector tools ask before running. |
| **Permissions** | Rules have the form `permission pattern → allow/ask/deny`. Within a scope the last match wins; locked org rules always win. Bash is matched per parsed sub-command. Secrets (`.env`, keys, `~/.ssh`) are hard-denied. Modes: `default`, `accept-edits`, `plan` (read-only), `bypass` (only if the org allows it). |
| **Approvals** | Approvals are held by the server. Any attached client can answer, and the first answer wins: approve a CLI action from the web UI, or the other way round. |
| **Undo** | Every step is snapshotted into a shadow git repo (separate from your `.git`). `/undo` and `/redo` restore both the files and the conversation. |
| **Extending** | `AGENTS.md`/`CLAUDE.md` instructions, `SKILL.md` skills, `.exa/agents/*.md`, `.exa/commands/*.md`, and MCP servers in `.exa/mcp.json` or `opencode.json`. The `.opencode/` and `.claude/` folders are also read. |

## CLI

```
exa                         interactive (server if logged in, else local)
exa -p "fix the failing test" -y
exa login [--server URL] | logout | whoami | sessions | usage | keys [add <provider>]
/model /agent /mode /undo /redo /compact /sessions /agents /commands /cost /thinking /exit
```

## Develop

```bash
bun run check       # typecheck + all tests (embedded Postgres)
bun run test:pg     # store + server suites against a real Postgres (EXA_TEST_DATABASE_URL)
```

| Package | Role |
|---|---|
| `packages/protocol` | Messages/parts, model I/O, versioned events, wire formats, API schemas |
| `packages/core` | Agent loop, permission engine, shell parser, agents, context/compaction, event bus |
| `packages/tools` | Built-in tools, path confinement, snapshots, skills/instructions, MCP client, apply_patch |
| `packages/router` | Provider adapters (OpenAI-compatible, Anthropic, Bedrock), `exa` orchestrator, vault, gateway |
| `packages/store` | Postgres/PGlite driver + RLS, the Drizzle ORM handle and table definitions, SQL migrations, local JSONL chat storage |
| `apps/server` | HTTP + SSE API: controllers → services → repositories → models, plus middlewares, server loop runtime, sandbox |
| `apps/cli` | Heavy client |
| `apps/web` | Web app (static ES modules, no build step, served by the server): chat, tasks, memory, tools, settings |

`harness/` is the v1 prototype, kept for reference. Code layout and conventions: [`docs/CODE_STYLE.md`](docs/CODE_STYLE.md) and [`AGENTS.md`](AGENTS.md). Database tables and diagrams: [`docs/12-database-map.html`](docs/12-database-map.html).
