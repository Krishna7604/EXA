# exa: notes for coding agents (and people)

Multi-tenant personal AI agent: one agent loop (`packages/core`) hosted by a CLI (`apps/cli`) and a server (`apps/server`), with a web app (`apps/web`). It researches, writes, plans, remembers, runs scheduled tasks and uses connected apps; with a workspace it also codes. Overview in `README.md`, as-built architecture in `docs/10-implementation.md`, the personal-agent design in `docs/13-personal-agent.md`.

## Rules
- Follow `docs/CODE_STYLE.md` for file layout, function size, naming and layering.
- Use `bun` (never npm/node). Run `bun run format` after editing, and `bun run check` before you finish. Both must pass.
- Packages import each other only through `@exa/<pkg>` (each package's `index.ts`). When you split a file, re-export it from `index.ts`.
- Refactors must not change behaviour or any test's expectations.
- `harness/` is the legacy v1 prototype. Don't edit it.

## Architecture in one picture
```
apps/server   HTTP request → middlewares → routes → controllers → services → repositories → models
apps/cli      main.ts → commands/ | session/ (ExaClient) → repl/ ; sync/ talks to the server
packages      protocol (shared types) → core (agent loop) → tools / router / store (db driver)
```
Folder and file naming rules (`<name>.<role>.ts`, e.g. `session.service.ts`) are in `docs/CODE_STYLE.md` §0.

## Where things are
| Need to change… | Look in |
|---|---|
| A server endpoint | `apps/server/src/routes/*.routes.ts` (URL table), `controllers/*.controller.ts` (input/output), `services/*.service.ts` (business rules) |
| A database query (Drizzle ORM) | `apps/server/src/repositories/*.repository.ts`, via `db.orm` / `db.withTenant(t, (q) => q.orm…)` |
| Table schema / migrations | `packages/store/src/migrations/schema.migrations.ts` (SQL, source of truth) and the matching Drizzle tables in `packages/store/src/tables/*.table.ts` (a test keeps them in sync) |
| Server data shapes | `apps/server/src/models/*.model.ts` |
| Auth, rate limits, CORS/headers | `apps/server/src/middlewares/` |
| Error codes, limits, setting defaults | `apps/server/src/constants/` |
| Server wiring (what gets constructed) | `apps/server/src/container.ts` |
| Web-chat agent loop, approvals, sandbox | `apps/server/src/runtime/` |
| Background cleanup | `apps/server/src/jobs/maintenance.job.ts` |
| Scheduled tasks | `services/task.service.ts`, `repositories/task.repository.ts`, `jobs/scheduler.job.ts`, `helpers/cron.helper.ts` |
| Long-term memory, chat search | `services/memory.service.ts`, `repositories/memory.repository.ts`; tools in `packages/tools/src/tools/memory/` |
| Connectors (server-side MCP) | `services/connector.service.ts`, `repositories/connector.repository.ts`, `helpers/mcp-connect.helper.ts` |
| Web search | tool `packages/tools/src/tools/web/websearch.tool.ts`, providers `web/search-providers.ts` |
| Agent loop | `packages/core/src/loop/`: `agent-loop.ts` (entry), `step-runner.ts` (one step), `tool-call.ts`, `compaction.ts` |
| Permissions | `packages/core/src/permission/` (engine, rules, gate, bash parsing) |
| Built-in agents | `packages/core/src/agents/` |
| Loop interfaces (ports), tool contract | `packages/core/src/models/` |
| A built-in tool | `packages/tools/src/tools/<area>/<name>.tool.ts` (fs, search, shell, patch, web, agent, memory) |
| MCP | `packages/tools/src/mcp/` |
| AGENTS.md / skills / commands discovery, undo snapshots | `packages/tools/src/workspace/` |
| Shared types, event and API schemas | `packages/protocol/src/models/`, `schemas/api.schema.ts` |
| Model providers | `packages/router/src/adapters/*.adapter.ts`; catalog in `providers/` |
| `exa` auto-router | `packages/router/src/routing/`; credentials/quotas in `gateway/` |
| CLI subcommands | `apps/cli/src/commands/*.command.ts` |
| CLI interactive mode | `apps/cli/src/repl/` |
| CLI ↔ server sync | `apps/cli/src/sync/` |
| Web UI | `apps/web/public/app.js` (entry), `js/services/` (API), `js/views/` (screens: chat, tasks, memory, connectors, settings), `js/helpers/`; styles in `css/` (`tokens.css` holds the Iris palette) |
