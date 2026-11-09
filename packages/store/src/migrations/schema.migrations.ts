// Schema migrations (applied in order, recorded in exa_migrations). Plain SQL — no ORM on the
// hot path. Design notes: docs/08 + docs/09.
//
//  * Global tables (no RLS, used by the auth layer): tenants, users, memberships, api_tokens,
//    device_codes, model_backends.
//  * Tenant tables: RLS policy `tenant_id = current_setting('exa.tenant_id')`, enforced for the
//    `exa_app` role that withTenant() switches to.
//  * Conversation content (messages, parts) exists ONLY for sessions with storage_mode='server'.
//  * usage_events / audit_log are append-only and range-partitioned by month.
//  * 003 adds the personal-agent tables (memories, scheduled tasks + runs) and full-text
//    search over stored chats. Drizzle table definitions in ../tables/ mirror this SQL.
import type { Db } from "../db/db.ts";

// ---------- constants ----------
/** Tenant tables created by 001. Frozen: 001's SQL is generated from this list. */
const INITIAL_TENANT_TABLES = [
  "projects",
  "settings",
  "permission_rules",
  "provider_keys",
  "quotas",
  "sessions",
  "session_leases",
  "approvals",
  "messages",
  "parts",
  "todos",
  "session_events",
  "usage_events",
  "audit_log",
  "mcp_servers",
  "skills",
  "agent_definitions",
  "commands",
  "secrets",
  "usage_rollups",
];

/** Tenant tables created by 003. */
const PERSONAL_TENANT_TABLES = ["memories", "scheduled_tasks", "task_runs"];

/** Tables that carry tenant_id and get the RLS policy + exa_app grants. */
export const TENANT_TABLES = [...INITIAL_TENANT_TABLES, ...PERSONAL_TENANT_TABLES];

// ---------- migrations ----------
export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "001_init",
    sql: `
do $$ begin create role exa_app nologin; exception when duplicate_object then null; end $$;

create table tenants (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  plan text not null default 'free',
  status text not null default 'active' check (status in ('active','suspended')),
  policy_version bigint not null default 1,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  email text not null unique,
  display_name text,
  auth_subject text unique,
  created_at timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  status text not null default 'active' check (status in ('invited','active','removed')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

create table api_tokens (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  name text,
  device_name text,
  token_hash bytea not null unique,
  scopes text[] not null default '{*}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index api_tokens_user_idx on api_tokens(user_id);

create table device_codes (
  device_code_hash bytea primary key,
  user_code text not null unique,
  tenant_id uuid,
  user_id uuid,
  status text not null default 'pending' check (status in ('pending','approved','denied','consumed')),
  client_name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table model_backends (
  id text primary key,
  provider text not null,
  model text not null,
  tier text not null check (tier in ('fast','balanced','strong')),
  free boolean not null default false,
  supports_tools boolean not null default false,
  context_window int not null,
  priority int not null default 100,
  enabled boolean not null default true,
  notes text
);

-- ---------- tenant-scoped ----------
create table projects (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  instructions text,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table settings (
  tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null check (scope in ('tenant','project','user')),
  scope_id uuid not null,
  key text not null,
  value jsonb not null,
  locked boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, scope, scope_id, key)
);

create table permission_rules (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null check (scope in ('tenant','project','user')),
  scope_id uuid not null,
  permission text not null,
  pattern text not null,
  action text not null check (action in ('allow','ask','deny')),
  locked boolean not null default false,
  priority int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index permission_rules_scope_idx on permission_rules(tenant_id, scope, scope_id);

create table provider_keys (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_scope text not null check (owner_scope in ('tenant','user')),
  owner_id uuid not null,
  provider text not null,
  label text,
  ciphertext bytea not null,
  wrapped_dek bytea not null,
  key_version int not null,
  last4 text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index provider_keys_active_idx on provider_keys(tenant_id, owner_scope, owner_id, provider) where revoked_at is null;

create table quotas (
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject_scope text not null check (subject_scope in ('tenant','user')),
  subject_id uuid not null,
  period text not null check (period in ('day','month')),
  max_tokens bigint,
  max_cost_usd numeric(14,6),
  max_requests int,
  primary key (tenant_id, subject_scope, subject_id, period)
);

create table sessions (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  project_id uuid,
  parent_id uuid,
  title text,
  directory text,
  agent text not null default 'build',
  model text not null,
  loop_host text not null check (loop_host in ('client','server')),
  storage_mode text not null check (storage_mode in ('none','local','server')),
  permission_mode text not null default 'default' check (permission_mode in ('default','accept-edits','plan','bypass')),
  status text not null default 'active' check (status in ('active','idle','ended')),
  revert jsonb,
  tokens_input bigint not null default 0,
  tokens_output bigint not null default 0,
  tokens_reasoning bigint not null default 0,
  tokens_cache_read bigint not null default 0,
  tokens_cache_write bigint not null default 0,
  cost_usd numeric(14,6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index sessions_user_recent_idx on sessions(tenant_id, user_id, updated_at desc);
create index sessions_parent_idx on sessions(parent_id) where parent_id is not null;

create table session_leases (
  session_id uuid primary key references sessions(id) on delete cascade,
  tenant_id uuid not null,
  holder_type text not null check (holder_type in ('device','server')),
  holder_id text not null,
  fencing bigint not null,
  expires_at timestamptz not null
);

create table approvals (
  id uuid primary key,
  tenant_id uuid not null,
  session_id uuid not null references sessions(id) on delete cascade,
  permission text not null,
  tool text,
  patterns text[] not null,
  title text not null,
  state text not null default 'pending' check (state in ('pending','once','always','reject','expired')),
  decided_by uuid,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null
);
create index approvals_pending_idx on approvals(session_id) where state = 'pending';

-- content: only for storage_mode = 'server'
create table messages (
  id uuid primary key,
  tenant_id uuid not null,
  session_id uuid not null references sessions(id) on delete cascade,
  parent_id uuid,
  role text not null check (role in ('user','assistant')),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index messages_session_idx on messages(session_id, id);
create index messages_retention_idx on messages(tenant_id, created_at);

create table parts (
  id uuid primary key,
  tenant_id uuid not null,
  session_id uuid not null references sessions(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  type text not null,
  data jsonb not null,
  blob_ref text,
  created_at timestamptz not null default now()
);
create index parts_message_idx on parts(message_id, id);
create index parts_session_idx on parts(session_id);

create table todos (
  tenant_id uuid not null,
  session_id uuid not null references sessions(id) on delete cascade,
  position int not null,
  content text not null,
  status text not null,
  priority text,
  updated_at timestamptz not null default now(),
  primary key (session_id, position)
);

-- short-retention outbox for cross-node fan-out / SSE resume (never the system of record)
create table session_events (
  tenant_id uuid not null,
  session_id uuid not null,
  seq bigint not null,
  type text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);
create index session_events_age_idx on session_events(created_at);

create table usage_events (
  id uuid not null,
  tenant_id uuid not null,
  user_id uuid,
  session_id uuid,
  model_requested text not null,
  model_used text not null,
  key_source text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  reasoning_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(14,8) not null default 0,
  latency_ms int,
  status text not null,
  ts timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);
create table usage_events_default partition of usage_events default;
create index usage_events_tenant_ts_idx on usage_events(tenant_id, ts);

create table usage_rollups (
  tenant_id uuid not null,
  subject_scope text not null,
  subject_id uuid not null,
  period text not null,
  period_start date not null,
  tokens bigint not null default 0,
  cost_usd numeric(14,6) not null default 0,
  requests int not null default 0,
  primary key (tenant_id, subject_scope, subject_id, period, period_start)
);

create table audit_log (
  id uuid not null,
  tenant_id uuid not null,
  actor_user_id uuid,
  device text,
  session_id uuid,
  action text not null,
  target text,
  decision text,
  meta jsonb,
  ts timestamptz not null default now(),
  primary key (id, ts)
) partition by range (ts);
create table audit_log_default partition of audit_log default;
create index audit_log_tenant_ts_idx on audit_log(tenant_id, ts);

create table mcp_servers (
  id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null, scope_id uuid not null, name text not null,
  transport text not null check (transport in ('stdio','http')),
  config jsonb not null, secret_id uuid,
  runs_on text not null check (runs_on in ('client','server')),
  enabled boolean not null default true
);
create table skills (
  id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null, scope_id uuid not null, name text not null, description text not null,
  body text not null, version int not null default 1, enabled boolean not null default true,
  unique (tenant_id, scope, scope_id, name)
);
create table agent_definitions (
  id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null, scope_id uuid not null, name text not null, description text not null,
  mode text not null check (mode in ('primary','subagent','all')), hidden boolean not null default false,
  prompt text not null, permission jsonb, model text, tier text, temperature numeric, steps int,
  options jsonb, enabled boolean not null default true,
  unique (tenant_id, scope, scope_id, name)
);
create table commands (
  id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null, scope_id uuid not null, name text not null, description text,
  agent text, model text, subtask boolean not null default false, template text not null,
  enabled boolean not null default true,
  unique (tenant_id, scope, scope_id, name)
);
create table secrets (
  id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, ciphertext bytea not null, wrapped_dek bytea not null, key_version int not null,
  unique (tenant_id, name)
);

${rlsFor(INITIAL_TENANT_TABLES)}
grant select on tenants, users, memberships, model_backends to exa_app;
grant usage on schema public to exa_app;
`,
  },

  {
    id: "002_partition_fn",
    sql: `
-- Create monthly partitions [start, start + n months) for the append-only tables.
create or replace function exa_ensure_partitions(months_ahead int default 2) returns void as $$
declare
  m date := date_trunc('month', now())::date;
  t text;
  i int;
  p date;
  name text;
begin
  foreach t in array array['usage_events','audit_log'] loop
    for i in 0..months_ahead loop
      p := (m + make_interval(months => i))::date;
      name := t || '_' || to_char(p, 'YYYYMM');
      if not exists (select 1 from pg_class where relname = name) then
        -- move any rows for that month out of the default partition first
        execute format('create table %I (like %I including defaults)', name, t);
        execute format('insert into %I select * from %I where ts >= %L and ts < %L', name, t || '_default', p, (p + interval '1 month')::date);
        execute format('delete from %I where ts >= %L and ts < %L', t || '_default', p, (p + interval '1 month')::date);
        execute format('alter table %I attach partition %I for values from (%L) to (%L)', t, name, p, (p + interval '1 month')::date);
      end if;
    end loop;
  end loop;
end $$ language plpgsql;

-- Drop whole months older than the retention window (cheap: no row-by-row delete).
create or replace function exa_drop_old_partitions(keep_months int) returns int as $$
declare
  r record;
  n int := 0;
  cutoff text := to_char((date_trunc('month', now()) - make_interval(months => keep_months))::date, 'YYYYMM');
begin
  for r in select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
           join pg_class p on p.oid = i.inhparent
           where p.relname in ('usage_events','audit_log') and c.relname ~ '_[0-9]{6}$' loop
    if right(r.relname, 6) < cutoff then
      execute format('drop table %I', r.relname);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$ language plpgsql;
`,
  },
  {
    id: "003_personal_agent",
    sql: `
-- every session's content is now stored by default; scheduled runs point back at their task
alter table sessions add column task_id uuid;
create index sessions_task_idx on sessions(task_id, created_at desc) where task_id is not null;

alter table mcp_servers add column created_at timestamptz not null default now();
alter table mcp_servers add column updated_at timestamptz not null default now();
create unique index mcp_servers_name_idx on mcp_servers(tenant_id, scope, scope_id, name);

create table memories (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  topic text not null,
  content text not null,
  source_session_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', topic || ' ' || content)) stored
);
create index memories_user_idx on memories(tenant_id, user_id, updated_at desc);
create index memories_search_idx on memories using gin(search);

create table scheduled_tasks (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  name text not null,
  prompt text not null,
  schedule text not null,
  timezone text not null default 'UTC',
  model text,
  agent text,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text check (last_status in ('running','ok','error')),
  last_session_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scheduled_tasks_user_idx on scheduled_tasks(tenant_id, user_id, created_at desc);
create index scheduled_tasks_due_idx on scheduled_tasks(next_run_at) where enabled;

create table task_runs (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references scheduled_tasks(id) on delete cascade,
  session_id uuid,
  trigger text not null check (trigger in ('schedule','manual')),
  status text not null check (status in ('running','ok','error')),
  error text,
  cost_usd numeric(14,6) not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index task_runs_task_idx on task_runs(task_id, started_at desc);

-- full-text search over stored chat text (user prompts and answers)
create index parts_text_search_idx on parts
  using gin (to_tsvector('english', coalesce(data->>'text', ''))) where type = 'text';

${rlsFor(PERSONAL_TENANT_TABLES)}
`,
  },
];

// ---------- migrate ----------
/** Apply pending migrations in order; returns the ids applied by this call. */
export async function migrate(db: Db & { exec(sql: string): Promise<void> }): Promise<string[]> {
  await db.exec(
    `create table if not exists exa_migrations (id text primary key, applied_at timestamptz not null default now())`,
  );
  const done = new Set(
    (await db.query<{ id: string }>(`select id from exa_migrations`)).map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // atomic: the DDL and the bookkeeping row commit together
    if (db.kind === "postgres") {
      // pooled driver: use a real driver transaction (multi-statement, no params = simple protocol)
      await db.tx(async (q) => {
        await q.query(m.sql);
        await q.query(`insert into exa_migrations (id) values ($1)`, [m.id]);
      });
    } else {
      await db.exec(
        `begin;\n${m.sql}\ninsert into exa_migrations (id) values ('${m.id}');\ncommit;`,
      );
    }
    applied.push(m.id);
  }
  return applied;
}

// ---------- helpers ----------
/** RLS policy keyed on `exa.tenant_id` plus the exa_app grants, for each table. */
function rlsFor(tables: string[]): string {
  return tables
    .map(
      (t) => `alter table ${t} enable row level security;
create policy ${t}_tenant on ${t} using (tenant_id = nullif(current_setting('exa.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('exa.tenant_id', true), '')::uuid);
grant select, insert, update, delete on ${t} to exa_app;`,
    )
    .join("\n");
}
