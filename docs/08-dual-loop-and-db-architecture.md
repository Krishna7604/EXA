# exa v2 — Dual Loop + Database Architecture

Date: 2026-10-10
Amends `07-multitenant-server-client-plan.md` section 3 (loop location). Monorepo confirmed.

## 1. Both loops, one implementation

`packages/core` holds a single pure agent loop (prompt assembly → model → tool calls → permission →
execute → results → repeat → stop). It takes injected `ModelPort`, `ToolExecutor`, `PermissionPort`,
`StorePort`, `EventSink`. It can be hosted in two places:

| | Client loop (heavy) | Server loop (light) |
|---|---|---|
| Loop runs in | CLI/desktop process | exa-server session runtime |
| Tools run | locally (shell, fs, git, local MCP) | server sandbox / remote MCP / RAG |
| Model calls | always through the exa gateway (keys, quota, `exa` router stay server-side) | same, in-process |
| Permission check | local engine using a **signed policy bundle** + server `authorize` call for server-only rules | server engine |
| Content storage | per `storage_mode` (`none`/`local`/`server`) | `none`/`server` |
| Needs server up? | yes (gateway + policy) | yes |

Why the client loop must exist: a shell command, file edit or local MCP server has to run next to the
user's files, and streaming each step through the server would add a round trip and make the server a
required relay for private data. So the heavy client runs the loop and the server stays the
**gateway + policy authority + state/audit sink**.

### Rules that keep the two from diverging

1. **One loop host per session at a time.** `sessions.loop_host = 'client' | 'server'` plus a lease
   (`session_leases`, fencing token). Whoever holds the lease runs the loop; others are viewers or
   approvers. Handoff (e.g. start in web, continue in CLI) = release lease + transfer context.
2. **Server stays authoritative even in client-loop mode:**
   - Models are reachable only via the gateway → BYOK keys, quota, model allowlist always enforced.
   - Client fetches a **signed policy bundle** (org rules, allowed tools, mode limits, version, expiry);
     it enforces it locally and refuses to run tools if the bundle is expired/unverifiable.
   - Rules that need the server (command classifier, cross-device approval, rate limits) call
     `POST /authorize` → `allow | ask | deny`. Fail closed on error.
   - Client streams **events** (tool name, decision, usage; content only if `storage_mode=server`) so
     audit, usage and other attached UIs stay correct.
3. **Same permission engine package** runs on both sides, so decisions are identical for identical
   inputs; the server additionally holds the rules the client can't be trusted with.
4. **Approvals are server-held state** in both modes: client asks → `approvals` row → any attached UI
   (web, phone, the CLI itself) answers → decision returns to the loop host.

## 2. Database principles

- Postgres, Drizzle migrations. One shared schema, `tenant_id` on every tenant-owned row, **RLS**
  (`USING tenant_id = current_setting('exa.tenant_id')::uuid`); app role has no BYPASSRLS.
- UUIDv7 primary keys (time-ordered, index-friendly).
- **Metadata always, content never by default.** Only `turns` holds conversation content, and only
  rows for sessions with `storage_mode='server'` ever exist.
- Hot/ephemeral state (leases, live connections, rate counters) → Redis later; Postgres holds the
  durable truth. Design works with Postgres-only at first.
- Secrets only as ciphertext (envelope encryption). No plaintext key column anywhere.
- Append-only, partitioned tables for high-volume data (`turns`, `usage_events`, `audit_log`).

## 3. Schema

### 3.1 Identity and tenancy
```sql
create table tenants (
  id uuid primary key, slug text unique not null, name text not null,
  plan text not null default 'free', status text not null default 'active',  -- active|suspended
  data_key_ref text not null,            -- KMS reference for this tenant's data key
  created_at timestamptz default now()
);

create table users (                      -- global identity (a person)
  id uuid primary key, email citext unique not null, display_name text,
  auth_subject text unique,               -- OIDC `sub`
  created_at timestamptz default now()
);

create table memberships (                -- user <-> tenant, role lives here
  tenant_id uuid references tenants, user_id uuid references users,
  role text not null check (role in ('owner','admin','member','viewer')),
  status text not null default 'active',  -- invited|active|removed
  primary key (tenant_id, user_id)
);

create table projects (
  id uuid primary key, tenant_id uuid not null references tenants,
  name text not null, instructions text,  -- the project's CLAUDE.md equivalent
  created_at timestamptz default now()
);
```

### 3.2 Devices, tokens, executors
```sql
create table devices (                    -- a registered heavy client install
  id uuid primary key, tenant_id uuid not null, user_id uuid not null,
  name text, platform text, client_version text, protocol_version int,
  last_seen_at timestamptz, revoked_at timestamptz
);

create table api_tokens (                 -- CLI / automation tokens (hash only)
  id uuid primary key, tenant_id uuid not null, user_id uuid not null, device_id uuid,
  token_hash bytea not null unique, scopes text[] not null,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz default now()
);
-- Web sessions use short-lived JWTs minted from OIDC; refresh tokens stored hashed in `auth_sessions`.
```

### 3.3 Settings and policy (layered, one generic mechanism)
```sql
create table settings (                   -- layered config, resolved org > project > user
  tenant_id uuid not null, scope text not null check (scope in ('tenant','project','user')),
  scope_id uuid not null,                 -- tenant_id | project_id | user_id
  key text not null,                      -- e.g. 'storage.mode', 'models.allowed', 'bypass.allowed'
  value jsonb not null, locked boolean not null default false,  -- locked = lower scopes can't override
  updated_by uuid, updated_at timestamptz default now(),
  primary key (tenant_id, scope, scope_id, key)
);

create table permission_rules (
  id uuid primary key, tenant_id uuid not null,
  scope text not null check (scope in ('tenant','project','user')), scope_id uuid not null,
  tool text not null,                     -- 'shell','write','mcp__slack__*'
  pattern text,                           -- 'npm run test:*', './secrets/**'
  effect text not null check (effect in ('allow','ask','deny')),
  priority int not null default 0, created_by uuid, created_at timestamptz default now()
);

create table policy_bundles (             -- signed snapshots handed to heavy clients
  id uuid primary key, tenant_id uuid not null, version bigint not null,
  payload jsonb not null, signature bytea not null, expires_at timestamptz not null,
  unique (tenant_id, version)
);
```
Resolution: deny beats ask beats allow; `locked` tenant settings win; the resolved result is compiled
into `policy_bundles` whenever settings/rules change.

### 3.4 Model gateway: backends, keys, quotas
```sql
create table model_backends (             -- platform-level registry (no tenant_id; admin-managed)
  id uuid primary key, provider text not null, model_id text not null,
  tier text not null check (tier in ('fast','balanced','strong')),
  is_free boolean default false, supports_tools boolean default false,
  context_window int, price_in_per_m numeric, price_out_per_m numeric,
  enabled boolean default true, priority int default 0, notes text
);

create table provider_keys (              -- BYOK
  id uuid primary key, tenant_id uuid not null,
  owner_scope text not null check (owner_scope in ('tenant','user')), owner_id uuid not null,
  provider text not null, label text,
  ciphertext bytea not null, wrapped_dek bytea not null, key_version int not null,
  last4 text,                             -- display only
  last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz default now()
);

create table quotas (
  tenant_id uuid not null, subject_scope text not null, subject_id uuid not null,
  period text not null,                   -- 'day'|'month'
  max_tokens bigint, max_cost_usd numeric, max_requests int,
  primary key (tenant_id, subject_scope, subject_id, period)
);
```
Key lookup order for a request: user's key for that provider → tenant's key → (if model is `exa`/pool)
platform pool. Admin setting `byok.enabled` / `models.allowed` gates this.

### 3.5 Sessions and live state (always stored; no content)
```sql
create table sessions (
  id uuid primary key, tenant_id uuid not null, user_id uuid not null, project_id uuid,
  title text,                              -- nullable; omit in storage_mode=none if you want zero content
  loop_host text not null check (loop_host in ('client','server')),
  storage_mode text not null check (storage_mode in ('none','local','server')),
  permission_mode text not null default 'default',   -- default|accept-edits|plan|bypass
  model text not null,                     -- 'exa' or 'openai/gpt-5'
  parent_session_id uuid,                  -- subagent / fork
  status text not null default 'active',   -- active|idle|ended
  created_at timestamptz default now(), last_active_at timestamptz,
  turn_count int default 0, compaction_count int default 0
);

create table session_leases (             -- one loop host at a time
  session_id uuid primary key, holder_type text not null,  -- 'device'|'server_node'
  holder_id uuid not null, fencing_token bigint not null, expires_at timestamptz not null
);

create table session_participants (       -- who is attached (viewer/approver/driver)
  session_id uuid, user_id uuid, device_id uuid, role text, joined_at timestamptz, left_at timestamptz,
  primary key (session_id, user_id, device_id)
);

create table approvals (
  id uuid primary key, tenant_id uuid not null, session_id uuid not null,
  tool text not null, args_hash bytea not null,
  args_preview text,                       -- truncated + redacted, shown to the human
  state text not null default 'pending',   -- pending|allowed|denied|expired
  decision_scope text,                     -- once|session|always
  decided_by uuid, requested_at timestamptz default now(), decided_at timestamptz, expires_at timestamptz
);
```

### 3.6 Content (OPTIONAL — only for `storage_mode='server'`)
```sql
create table turns (
  id uuid not null, tenant_id uuid not null, session_id uuid not null,
  parent_id uuid,                          -- chain, enables rewind/branch like parentUuid
  seq int not null, role text not null,    -- user|assistant|tool|system|summary
  is_sidechain boolean default false,      -- subagent work
  content jsonb not null,                  -- blocks; big payloads replaced by blob_ref
  blob_ref text,                           -- object storage key for large tool outputs/images
  token_count int, ts timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);                 -- monthly partitions; retention = drop old partitions
create index on turns (session_id, seq);
```
Compaction writes a `summary` turn; older turns stay until retention drops them.
File snapshots for undo/rewind: `file_snapshots(session_id, path, blob_ref, turn_id)`, same optional rule.
`local` mode writes the identical record shape to `~/.exa/sessions/<id>.jsonl`; no rows here.

### 3.7 Usage, audit (no prompt content)
```sql
create table usage_events (               -- partitioned monthly; feeds quotas + billing
  id uuid not null, tenant_id uuid not null, user_id uuid, session_id uuid,
  model_requested text, backend_id uuid, key_source text,   -- 'byok_user'|'byok_tenant'|'pool'
  input_tokens int, output_tokens int, cached_tokens int, cost_usd numeric, latency_ms int,
  status text, ts timestamptz not null default now(), primary key (id, ts)
) partition by range (ts);

create table audit_log (                  -- append-only; tool + decision, not args content
  id uuid not null, tenant_id uuid not null, actor_user_id uuid, device_id uuid, session_id uuid,
  action text not null,                    -- tool.run|tool.denied|approval.decided|key.created|setting.changed|login
  target text, decision text, rule_id uuid, meta jsonb, ts timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);
-- REVOKE UPDATE, DELETE on audit_log from the app role.
```
Gateway writes usage rows in batches; per-period totals for quota checks come from a rolled-up
`usage_rollups(tenant_id, subject, period_start, tokens, cost)` table (or Redis counters).

### 3.8 Extensibility (per tenant/project, mirrors skills / MCP / plugins / subagents)
```sql
create table mcp_servers (
  id uuid primary key, tenant_id uuid not null, scope text, scope_id uuid,
  name text not null, transport text not null,   -- 'stdio'|'http'
  config jsonb not null, secret_ref uuid,         -- credentials via encrypted secrets, not inline
  runs_on text not null check (runs_on in ('client','server')), enabled boolean default true
);
create table skills (id uuid primary key, tenant_id uuid not null, scope text, scope_id uuid,
  name text not null, description text not null, body text not null, version int, enabled boolean default true);
create table agent_definitions (id uuid primary key, tenant_id uuid not null, scope text, scope_id uuid,
  name text not null, prompt text not null, tools text[], model text, enabled boolean default true);
create table hooks (id uuid primary key, tenant_id uuid not null, scope text, scope_id uuid,
  event text not null,                           -- PreToolUse|PostToolUse|UserPromptSubmit|Stop|SessionStart
  matcher text, action jsonb not null, runs_on text not null, enabled boolean default true);
create table secrets (id uuid primary key, tenant_id uuid not null, name text not null,
  ciphertext bytea not null, wrapped_dek bytea not null, key_version int);
```
`runs_on` matters: a `client` hook/MCP server is shipped to the heavy client in the policy bundle;
a `server` one executes in the server loop or the server-side authorize call.

### 3.9 Server sandbox (light clients)
```sql
create table sandboxes (
  id uuid primary key, tenant_id uuid not null, session_id uuid, image text,
  state text,                              -- provisioning|ready|suspended|destroyed
  node text, created_at timestamptz, last_active_at timestamptz, expires_at timestamptz
);
```
Workspace files live in object storage / volume, referenced by `sandbox.id`, never in Postgres.

## 4. Entity map

```
tenants ─┬─ memberships ─ users ─┬─ devices ─ api_tokens
         ├─ projects             └─ provider_keys(user)
         ├─ settings / permission_rules / policy_bundles
         ├─ provider_keys(tenant) · quotas · secrets
         ├─ mcp_servers · skills · agent_definitions · hooks
         └─ sessions ─┬─ session_leases · session_participants · approvals · sandboxes
                      └─ turns*  (only storage_mode=server)
usage_events · audit_log  (tenant-scoped, partitioned, append-only)
model_backends            (platform-wide registry)
```

## 5. How the storage setting actually gates writes

```
effective_mode = resolve(settings['storage.mode'] tenant→project→user, honoring locked)
  none   → sessions row + usage + audit only
  local  → same, plus client writes JSONL locally (client loop only)
  server → same, plus StorePort(PG) writes turns in batched flushes
```
`StorePort` is the only code that writes content; the loop never touches the DB directly, so the mode
check lives in one place and a test can assert "mode=none ⇒ zero rows in `turns`".

## 6. Load and scale notes

- Writes per turn in `none`/`local`: ~1 usage row + occasional audit rows. In `server`: + turn rows,
  batched (flush every N turns / 2 s), large outputs to object storage.
- Partition `turns`, `usage_events`, `audit_log` by month; retention job drops partitions (per-tenant
  retention overrides handled by deleting rows for shorter-retention tenants before the partition ages out).
- Indexes: `(tenant_id, …)` leading everywhere for RLS; `sessions(tenant_id,user_id,last_active_at desc)`.
- Read replicas for admin/analytics; PgBouncer in transaction mode (so set `exa.tenant_id` with
  `SET LOCAL` inside each transaction).

## 7. Tests this schema must pass

1. Cross-tenant read/write attempts return zero rows (RLS) for every table.
2. `storage.mode=none` ⇒ no `turns` rows after a full tool-using session.
3. `locked` tenant setting cannot be overridden by user or project.
4. Two hosts can't run one session: second lease acquire fails; stale fencing token rejected.
5. Revoked token/device is refused within the policy-bundle TTL.
6. Plaintext key never appears in DB dump, logs or API responses.
