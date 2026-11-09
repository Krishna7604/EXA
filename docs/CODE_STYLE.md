# Code style

How code is laid out in this repo. Every file follows the same shape, so whether you are a person or an agent, you know where to look before you open it.

Based on the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), plus common clean-code practice (single responsibility, small functions, top-down reading order). Formatting is enforced by [Biome](https://biomejs.dev); everything else here is checked in review.

```bash
bun run format      # format + sort imports + safe lint fixes
bun run lint        # check only (CI)
bun run check       # typecheck + all tests
```

---

## 0. Project structure

### The server: Controller → Service → Repository → Model

`apps/server` is a web API, and it follows the classic layered architecture. **A request only ever flows down through the layers:**

```
HTTP request
  → middlewares/   authenticate, rate-limit, security headers
  → routes/        map URL + method to a controller method (a table, no logic)
  → controllers/   parse + validate input (zod DTO from models/), check role, call ONE service, shape the response
  → services/      business rules; plain inputs and outputs; no Request/Response, no SQL
  → repositories/  database access only (Drizzle ORM); one repository per table group; returns models
  → models/        entities, DTOs and row types (data shapes, no logic)
```

The rest of the server is organized like this:

| Folder | Holds | Rule |
|---|---|---|
| `controllers/` | `session.controller.ts` … | Each method is about 15 lines. No business rules, no SQL. |
| `services/` | `session.service.ts` … | Never imports from `controllers/` or HTTP helpers. Throws typed errors. |
| `repositories/` | `session.repository.ts` … | The only place the database is queried, through the Drizzle query builder (`db.orm`, or `q.orm` inside `db.withTenant`). Raw `q.query()` only where the ORM can't express it, with a one-line comment saying why. No business rules. |
| `models/` | `session.model.ts` … | Types and zod schemas only. |
| `subscribers/` | `audit.subscriber.ts` … | React to events on the event bus (audit, usage). Services publish events; subscribers do the side effects. |
| `middlewares/` | `auth.middleware.ts` … | Run before controllers. |
| `routes/` | `session.routes.ts` … | A route table only. |
| `helpers/` | `sse.helper.ts` … | Small, stateless, reusable functions. No business rules. |
| `constants/` | `limits.constants.ts`, `errors.constants.ts` | Named values only. |
| `jobs/` | `maintenance.job.ts` | Periodic background work. |
| `runtime/` | web-chat agent loop, sandbox, approval broker | The server's agent-hosting domain. |
| `config/` | `env.config.ts` | Reading the environment. |

Dependencies point downward only. Controllers depend on services, and services depend on repositories and models. A lower layer never imports a higher one.

### Packages and the CLI: same folder names, only where they apply

The libraries (`core`, `tools`, `router`, `protocol`, `store`) and the CLI have no HTTP and (mostly) no database, so they have no controllers or repositories. **We don't create empty or fake layers.** They use the same shared folder names wherever there is something real to hold, plus feature folders:

| Folder | Used for |
|---|---|
| `models/` | Types, interfaces and entities (`*.model.ts`). Zod schemas go in `schemas/` (`*.schema.ts`). |
| `constants/` | Named values (`*.constants.ts`). |
| `helpers/` | Small stateless functions shared inside the package (`*.helper.ts`). |
| feature folders | The package's real domains: `loop/`, `permission/`, `tools/fs/`, `adapters/`, `commands/`, `sync/`, … |

Each package's `index.ts` stays at `src/index.ts` and only re-exports.

### File names: `<name>.<role>.ts`

A file that plays a known role carries that role as a dot suffix, so the layer shows in the file name, in search results and in stack traces:

| Role | Example |
|---|---|
| controller / service / repository / model | `session.controller.ts`, `session.service.ts`, `session.repository.ts`, `session.model.ts` |
| schema / subscriber / middleware / routes | `session.schema.ts`, `audit.subscriber.ts`, `auth.middleware.ts`, `session.routes.ts` |
| table (Drizzle table definitions, `packages/store/src/tables/`) | `session.table.ts` |
| helper / constants / config / job | `sse.helper.ts`, `limits.constants.ts`, `env.config.ts`, `maintenance.job.ts` |
| tool / adapter / command | `read.tool.ts`, `anthropic.adapter.ts`, `login.command.ts` |
| test | `session.service.test.ts` (in `__tests__/`) |

A file with no such role is plain `kebab-case.ts` (`agent-loop.ts`, `bash-parse.ts`). The name before the dot is kebab-case (`client-sync.service.ts`).

## 1. File layout

Every `.ts` file has these sections, **in this order**. Skip any section that would be empty. Put one blank line between sections.

```ts
// Session repository: session metadata in Postgres, message content only when
// storage_mode = "server".                                 ← 1. Header: what this file is for (1–3 lines)

import { z } from "zod";                                   ← 2. Imports (Biome sorts them)
import type { SessionInfo } from "@exa/protocol";

// ---------- constants ----------                          ← 3. Constants
const MAX_CACHED_SESSIONS = 500;

// ---------- types ----------                              ← 4. Types and interfaces
export interface SessionMeta { ... }

// ---------- session repo ----------                       ← 5. Main code: the exported classes/functions
export class SessionRepo { ... }

// ---------- helpers ----------                            ← 6. Private helpers (not exported)
function rowToSession(row: SessionRow): SessionInfo { ... }
```

Why this order: when you open a file you first see **what it is**, then **what it depends on**, then **what it exports**, and only then **the details**. Helpers go last ("newspaper order") because `function` declarations are hoisted, so they can be used above where they are written.

Section dividers use the form `// ---------- name ----------`, lowercase. Use them in any file longer than about 80 lines.

## 2. One job per file

- A file should be describable in **one sentence without "and"**. If it can't, split it.
- **About 300 lines is the soft limit** for a file. Going over is fine when the file is still one job (for example, the agent loop). Over 400 lines should be rare.
- **No grab-bag files.** Don't create `utils.ts`, `misc.ts` or `helpers.ts`; name each file after what it does.
- A package's `index.ts` only re-exports. Other packages import from `@exa/<pkg>`, never from deep paths. That means splitting a file inside a package never breaks callers.

## 3. Functions

- **Aim for under about 40 lines; more than 60 is a refactor signal.** If you need a comment like `// now handle X` inside a function, that block probably belongs in its own function named `handleX`.
- **One level of abstraction per function.** A high-level function reads like a list of steps:
  ```ts
  async runStep(state: StepState) {
    const reply = await this.callModel(state);
    const calls = this.collectToolCalls(reply);
    await this.executeToolCalls(state, calls);
    return this.finishStep(state, reply);
  }
  ```
- **Return early** instead of nesting `if`s.
- **At most 3 positional parameters.** For more, pass one options object.
- **No boolean flag parameters that switch behaviour.** Write two functions instead.
- Use `function` declarations for named module-level functions. Keep arrow functions for callbacks and one-line helpers.

## 4. Readable expressions

- **One decision per line.** Don't chain more than two `??`/`||` fallbacks or nest ternaries. Use named variables or a small function instead:
  ```ts
  // ✗
  let mode = locked ?? requested ?? (s.values["storage.mode"] as StorageMode | null) ?? (host === "client" ? "local" : "none");

  // ✓
  const orgDefault = s.values["storage.mode"] as StorageMode | null;
  const hostDefault: StorageMode = host === "client" ? "local" : "none";
  let mode = locked ?? requested ?? orgDefault ?? hostDefault;
  ```
- **No magic numbers or strings.** Put them in a named `UPPER_SNAKE_CASE` constant at the top of the file, or in the package's config.
- **Don't assign inside conditions** (`while ((m = re.exec(s)))`), and don't use comma expressions.
- Keep lines at 100 characters or fewer (Biome enforces this).

## 5. Classes

Members go in this order:

1. static fields
2. instance fields (`private readonly` first)
3. `constructor`
4. public methods, in the order a caller would use them
5. private methods, below the public ones

Keep classes focused. If a class has two groups of methods that never touch each other's fields, it is two classes.

## 6. Naming

| Thing | Style | Example |
|---|---|---|
| Files | `<name>.<role>.ts`, or `kebab-case.ts` when there is no role (see §0) | `session.service.ts`, `bash-parse.ts` |
| Classes, interfaces, types | `PascalCase` | `AgentLoop`, `SessionStore` |
| Functions, variables, methods | `camelCase` | `resolveStorageMode` |
| Module-level constants | `UPPER_SNAKE_CASE` | `MAX_OUTPUT_CHARS` |
| Booleans | `is/has/can/should` | `isBusy`, `hasRevert` |

- **Names say what a thing is, not how it is built.** Write `pendingApprovals`, not `map2`.
- **Short names only in tiny scopes.** `i`, `e` and `p` are fine inside a 3-line callback, but not across a 50-line function.
- **No `I` prefix on interfaces and no `Impl` suffix.**

## 7. Types

- **Avoid `any`.** Use `unknown` and narrow it, or write the real type. (Biome warns on `any`.)
- **Exported functions declare their return type.**
- **Use `import type` for type-only imports.** Biome fixes this automatically.
- **Validate untrusted input once, at the edge**, with zod schemas from `@exa/protocol`. Inside the system, trust the types.

## 8. Comments

- **Header comment on every file.** Say what the file is for, plus anything non-obvious.
- **JSDoc (`/** ... */`) on exported things whose name isn't self-explanatory.** One line is usually enough.
- **Comments explain *why*, not *what*.** If you need to explain *what*, rename things or extract a function instead.
- **Keep comments current.** A wrong comment is worse than none.

## 9. Layering (apps/server)

See §0. In short: `controller → service → repository → model`, with dependencies pointing downward only. A controller method is about 15 lines; anything longer belongs in a service. Database access appears only in `repositories/`.

**Database rules.** Schema changes are a new SQL migration in `schema.migrations.ts` plus the matching change in `packages/store/src/tables/` (the `tables.test.ts` mirror test fails otherwise). Use the portable `jsonb`/`bytea` column types from `@exa/store` — Drizzle's built-in `jsonb` double-encodes on Bun's driver. Avoid `orm.execute()`; its result shape differs between Bun SQL and PGlite.

## 10. Errors

- **Throw typed errors** (`HttpError`, `ModelError`, `PermissionDeniedError`), not bare strings.
- **Never swallow an error silently.** `catch {}` needs a comment saying why ignoring it is safe.

## 11. Tests

- **Tests live in `src/__tests__/<file>.test.ts`** next to the code.
- **A refactor must keep `bun run check` green without changing any test's expectations.**
