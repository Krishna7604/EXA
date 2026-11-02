# exa v2 — What to Take from OpenCode

Date: 2026-10-10
Source: `thrivesparrow/docs/opencode-harness/` (11 files, written against opencode v1.18.35, claims tagged
DOC/OBS/INF). I have read that write-up, **not** the OpenCode source or docs themselves, so treat the
details as "as reported there". Amends docs 07 and 08.

## 1. What OpenCode is, relative to exa

OpenCode = client-server app with a **server-side loop**; TUI / IDE / SDK are thin HTTP clients on an
OpenAPI + SSE (`GET /event`) interface. But the server is a local process on the same machine as the
files, so it never needs a remote executor. exa's differentiator is exactly the part OpenCode doesn't
have: **multi-tenant, remote, with the loop able to live on the client** (doc 08). OpenCode validates
the thin-client + event-stream half of our design and gives a lot of detail for the rest.

## 2. Adopt (strong fit, low risk)

| Idea in OpenCode | Why it matters for exa | Where it lands |
|---|---|---|
| **Typed event bus over SSE, versioned types (`message.updated.1`)**; clients never poll; unknown versions ignored | Exactly the protocol we need for heavy/light/multi-device attach; versioning lets old clients survive | `packages/protocol`; add `type@version` to every event |
| **Message tree (`parentID`) + typed parts**: `text, reasoning, tool, step-start, step-finish, patch, file, compaction` | Richer and more queryable than our single `turns.content`; enables fork/rewind and a UI that renders parts | Replace `turns` with `messages` + `parts` (section 5) |
| **Tool part state machine**: `pending→running→completed\|error`, with `input, output, metadata{exit,truncated}, title, time` | Clients render progress without re-deriving; exit code kept separate from model-visible output; `title` pre-rendered | `ToolPart` type in protocol |
| **Truncate big tool output, offload full copy** (`tool-output/`) | Keeps context and DB small; we already planned `blob_ref` | tool result pipeline |
| **Step bracket with tokens/cost per LLM call** (`step-finish`) + totals denormalized on session row | Cheap usage reporting and per-session cost without scans | `parts(step-finish)` + `sessions` totals |
| **Permission semantics**: allow/ask/deny; glob patterns on the *resource* (path, URL, subagent name); **bash matched on the parsed command**, not the raw string; `external_directory` as its own key; `.env` denied by default (`*.env.example` re-allowed) | Fixes the exact holes found in review (`rm -fr`, path escape, `.env` read) with a proven model | `packages/core` permission engine |
| **`deny` removes the tool from the model's schema list** (and from Task's subagent list) | Saves tokens and the model never tries it | prompt assembly filters tools by policy |
| **Doom-loop guard**: same tool+input 3× → recovery prompt, gated by permission | Real failure mode (retrying a failing edit) | loop in `core` |
| **Step cap behavior**: at limit, inject "summarize + remaining work" prompt, text-only answer | Graceful stop instead of a hard error | loop in `core` |
| **Primary vs subagent agents** (`build`, `plan` primary; `explore`, `general` subagents; hidden `compaction`/`title`/`summary`) | Our modes (plan/default) become *agents*; hidden utility agents run on the cheap tier | `agent_definitions` + builtin set |
| **Subagent = child session** (`parent_id`), `subagent_depth` default 1, `task` permission by name | Inspectable delegation, no fan-out explosions | `sessions.parent_session_id` + depth setting |
| **Agent `description` is a routing hint** ("when to use / what it can't do") | Directly improves delegation quality | authoring guideline + lint |
| **`small_model`** for titles/summaries; subagents inherit parent's model unless overridden (a cost trap) | Maps onto exa tiers: utility agents default to `fast` tier | router config |
| **Skills**: only name+description in context, body via `skill()` call; name rule `^[a-z0-9]+(-[a-z0-9]+)*$`, must match dir | Same as Claude Code; the two ecosystems already share formats | `skills` table + file import |
| **Rules file `AGENTS.md`** with `CLAUDE.md` fallback, walk up to repo root; extra `instructions` globs/URLs (5 s timeout) | One instructions format across tools; our repo already has `.agents/skills` | prompt assembly |
| **Layered config, merged not replaced; org defaults fetched from a remote `.well-known`; managed config is highest priority** | Same as our `settings` layering; remote org defaults = our policy bundle | `settings` + `policy_bundles` |
| **Plugin hooks**: `tool.execute.before` (throw = block, mutate = rewrite args), `tool.execute.after`, `shell.env`, `session.compacting` | Our hooks table needs a concrete interface; "throw to block, mutate to rewrite" is simple and powerful | `core` hook runner; `runs_on` client/server |
| **Custom tools**: file → tool name, Zod schema + `.describe()`, context `{sessionID, messageID, directory, worktree}`; same name overrides built-in | Gives tenants/users extensibility with a typed contract; use `worktree` not `process.cwd()` | `packages/tools` plugin API |
| **Slash commands as markdown + frontmatter**, `$ARGUMENTS`, `!cmd`, `@file`, `subtask: true` (child session keeps primary context clean) | Cheap, loved feature | `commands` table + file import |
| **Tool set details**: `edit` (must match uniquely) over `write`; `apply_patch`; `grep` via ripgrep honoring `.gitignore`; `glob` sorted by mtime; `read` with line ranges; `question`; `todowrite`; `webfetch` | Our current tools are stubs; these are the proven behaviors | `packages/tools` |

## 3. Adapt (good idea, but our situation differs)

- **Git snapshot around every step → `/undo`, `/redo`, `revert` marker stored as a column.** Great for the
  heavy client (shadow git repo next to the workspace, snapshot id on `step-start`/`step-finish`). For
  light/server mode snapshot the sandbox volume. Revert = a marker on the session; the context builder
  skips reverted messages, so no replay. Compaction must carry cumulative diffs forward and not touch the
  snapshot chain. **We were missing undo entirely** — add it. Store only the snapshot *id* in the DB.
- **Event sourcing.** OpenCode writes every change twice (projection rows + full event log) and the log
  became **84 % of a 736 MB DB** because each event carries the whole mutated object (a 100 KB compaction
  summary re-serialized on every update). That is precisely your DB-load worry. For exa: keep the **SSE
  event stream** (needed), but persist **final part state only**; deltas are never stored. If we want
  resumable streams, keep a **short-retention `session_events` outbox** (seq per session, TTL minutes to
  hours, deltas allowed) so `Last-Event-ID` reconnect works without making it the system of record.
- **JSON blob payloads** (new part types need no migration) vs columns. Their rule is right and matches
  our schema: *blobs for mutable/evolving payloads; real columns for anything filtered or ordered by*
  (todos, usage, session totals). Keep that discipline; their weakness is no partial reads of huge blobs,
  so large things (diffs, outputs) go to `blob_ref`.
- **`opencode serve` as a worker.** It exposes OpenAPI + SSE and an SDK, so exa could drive it as an
  *external harness* behind a `HarnessAdapter` (exa as orchestrator of other harnesses, as you described).
  Treat as an experiment after P2; verify licensing and API stability first.
- **OpenCode's free `opencode` provider models and hosted websearch MCP** could be entries in the `exa`
  free pool. Their availability/terms are unverified here; keep them config-driven, never hard-wired.
- **Context epochs** (`baseline`, `snapshot`, `baseline_seq`): replay only events after an anchor instead
  of walking history from zero. Their tables are still empty (work in progress), so treat as a direction,
  not proof. Our compaction already writes a `summary` message; add `compaction` part with `tail_start_id`
  (messages from there stay verbatim, earlier ones replaced by the summary).
- **Permission rule resolution.** OpenCode: *last matching rule wins* (catch-all first). Claude Code:
  *deny > ask > allow*. Proposal for exa: **across scopes** higher scope wins and `locked` is absolute
  (tenant > project > user); **within one scope** last-match-wins like OpenCode (easier to author:
  `"*": ask`, then specifics). `deny` at any tenant-locked level can never be re-allowed below it.

## 4. Avoid (their pain points)

1. Full-object events persisted per update (see above).
2. No `auto_vacuum`/retention story → file only grows. We use partition drops + TTL from day one.
3. Plugins/`shell.env` affecting the user's own terminal shells is surprising. Hook scope must be per
   session/agent only.
4. Tool/permission config keys that diverge from tool names (`write` gated by `edit`). Keep a visible
   mapping table in the admin UI, or use one key per tool plus aliases.
5. Unbounded steps by default. We default `maxSteps` and `maxCost` on (exa config already has both).
6. Subagents inheriting the parent's frontier model by default. Default utility/read-only subagents to
   the `fast` tier.
7. LSP in context: OpenCode's own docs say it is often a net negative; prefer `bash typecheck`.
   **Don't build LSP in v2.**
8. Large MCP schemas always in context is "the single biggest lever on cost". Add deferred tool loading
   (name only, schema on demand) — Claude Code already does this; OpenCode leaves it to the user.

## 5. Schema changes to doc 08

Replace `turns` (3.6) with messages + parts, still only for `storage_mode='server'`:

```sql
create table messages (
  id uuid not null, tenant_id uuid not null, session_id uuid not null,
  parent_id uuid,                       -- tree: enables fork / revert / rewind
  role text not null,                   -- user|assistant
  agent text, model text,               -- which agent/model produced it
  summary boolean default false,        -- compaction message
  tokens jsonb, cost_usd numeric, finish text,   -- rolled up from step-finish
  ts timestamptz not null default now(), primary key (id, ts)
) partition by range (ts);

create table parts (
  id uuid not null, tenant_id uuid not null, session_id uuid not null, message_id uuid not null,
  type text not null,                   -- text|reasoning|tool|step-start|step-finish|patch|file|compaction
  data jsonb not null,                  -- final state only; tool: {tool, callId, status, input, metadata, title, time}
  blob_ref text,                        -- full output / diff / image offloaded
  ts timestamptz not null default now(), primary key (id, ts)
) partition by range (ts);
create index on parts (session_id, ts);
```

Add to `sessions`: `directory text` (workspace anchor), `agent text`, `revert jsonb`
(`{message_id, part_id}`), `tokens_input/output/reasoning/cache_read/cache_write bigint`, `cost_usd numeric`,
`summary_additions/deletions/files int`, `time_compacting timestamptz` (in-flight compaction guard),
`archived_at timestamptz`, `share_url text` (optional).

New tables:

```sql
create table session_events (          -- SHORT-retention outbox for SSE resume; not system of record
  session_id uuid not null, seq bigint not null, type text not null,   -- 'message.part.updated@1'
  data jsonb not null, created_at timestamptz default now(), primary key (session_id, seq)
);                                     -- purged by TTL job (e.g. 1h); deltas allowed here only

create table snapshots (               -- optional metadata; the data lives in shadow git / volume
  id uuid primary key, tenant_id uuid not null, session_id uuid not null,
  part_id uuid, ref text not null, kind text,       -- 'git'|'volume'
  created_at timestamptz default now()
);

create table todos (                   -- relational because queried positionally (OpenCode does the same)
  session_id uuid not null, position int not null, content text not null,
  status text not null, priority text, updated_at timestamptz default now(),
  primary key (session_id, position)
);

create table commands (id uuid primary key, tenant_id uuid not null, scope text, scope_id uuid,
  name text not null, description text, agent text, model text, subtask boolean default false,
  template text not null, enabled boolean default true);
```

`agent_definitions` (doc 08 3.8) gains: `mode text check (mode in ('primary','subagent','all'))`,
`hidden boolean`, `description text not null` (routing hint), `permission jsonb`, `steps int`,
`temperature numeric`, `options jsonb` (passed straight to the provider, like OpenCode's escape hatch).
`model_backends` gains `kind` (`'provider'|'harness'`) for the future `HarnessAdapter`.
`permission_rules.tool` uses OpenCode-style keys: `read, edit, bash, glob, grep, list, task, skill,
webfetch, websearch, external_directory, doom_loop, question`.

## 6. Changes to the plan (doc 07 phases)

- **P0:** adopt OpenCode's default permission shape: deny `.env` reads (re-allow `*.env.example`),
  `external_directory` = ask, bash matched on parsed command, `doom_loop` = ask.
- **P1:** loop emits `step-start/step-finish` parts with token/cost; tool part state machine;
  truncate-and-offload; doom-loop + step-cap prompts; builtin agents `build`/`plan`/`explore`/`general`
  plus hidden `compaction`/`title`/`summary`; compaction with `tail_start_id` and carried diffs;
  **snapshots + `/undo` `/redo`** on the heavy client.
- **P2:** protocol = versioned typed SSE events (`type@version`); `Last-Event-ID` resume via
  `session_events`; OpenAPI generated from zod; `GET /session/:id/diff` for clients with no filesystem.
- **P3:** storage uses `messages`/`parts` (final state only); no per-delta persistence.
- **P4:** `exa` tiers wired to `small_model`-style utility routing; optionally add OpenCode-hosted free
  models as pool entries after verifying terms.
- **P6:** `HarnessAdapter` experiment (drive `opencode serve`); commands and custom-tool plugin API;
  remote org defaults endpoint (`/.well-known/exa`) feeding `policy_bundles`.

## 7. One-line verdict

Take OpenCode's **protocol, message/part model, permission semantics, agent model and extension
shapes**; do **not** copy its **persist-every-event storage**, which is the exact DB-load problem you
want to avoid.
