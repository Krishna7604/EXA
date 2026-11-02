// Row mapping and write statements for the session tables, shared by SessionRepo's methods
// (some run inside a larger transaction, so they take a Queryable rather than a Db).
import type { MessageInfo, Part, SessionInfo, Tokens } from "@exa/protocol";
import type { Queryable } from "@exa/store";

// ---------- row mapping ----------
export function sessionFromRow(r: any): SessionInfo {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    projectId: r.project_id ?? null,
    parentId: r.parent_id ?? null,
    title: r.title ?? null,
    directory: r.directory ?? null,
    agent: r.agent,
    model: r.model,
    loopHost: r.loop_host,
    storageMode: r.storage_mode,
    status: r.status,
    revert: r.revert ?? null,
    tokens: {
      input: Number(r.tokens_input),
      output: Number(r.tokens_output),
      reasoning: Number(r.tokens_reasoning),
      cacheRead: Number(r.tokens_cache_read),
      cacheWrite: Number(r.tokens_cache_write),
    },
    cost: Number(r.cost_usd),
    time: {
      created: new Date(r.created_at).getTime(),
      updated: new Date(r.updated_at).getTime(),
      ...(r.archived_at ? { archived: new Date(r.archived_at).getTime() } : {}),
    },
  };
}

// ---------- writes ----------
export async function insertSession(q: Queryable, info: SessionInfo, permissionMode: string) {
  await q.query(
    `insert into sessions (id, tenant_id, user_id, project_id, parent_id, title, directory, agent, model, loop_host, storage_mode, permission_mode, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      info.id,
      info.tenantId,
      info.userId,
      info.projectId,
      info.parentId,
      info.title,
      info.directory,
      info.agent,
      info.model,
      info.loopHost,
      info.storageMode,
      permissionMode,
      info.status,
    ],
  );
}

export async function updateSession(
  q: Queryable,
  id: string,
  patch: Partial<SessionInfo> & { permissionMode?: string },
) {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown, cast = "") => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.agent !== undefined) set("agent", patch.agent);
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.directory !== undefined) set("directory", patch.directory);
  if (patch.permissionMode !== undefined) set("permission_mode", patch.permissionMode);
  if (patch.revert !== undefined)
    set("revert", patch.revert === null ? null : JSON.stringify(patch.revert), "::text::jsonb");
  if (patch.tokens) {
    const t: Tokens = patch.tokens;
    set("tokens_input", t.input);
    set("tokens_output", t.output);
    set("tokens_reasoning", t.reasoning);
    set("tokens_cache_read", t.cacheRead);
    set("tokens_cache_write", t.cacheWrite);
  }
  if (patch.cost !== undefined) set("cost_usd", patch.cost);
  if (patch.time?.archived !== undefined)
    set("archived_at", new Date(patch.time.archived).toISOString(), "::timestamptz");
  if (!sets.length) return;
  await q.query(`update sessions set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
}

export async function putMessage(q: Queryable, tenantId: string, info: MessageInfo) {
  await q.query(
    `insert into messages (id, tenant_id, session_id, parent_id, role, data) values ($1,$2,$3,$4,$5,($6::text)::jsonb)
     on conflict (id) do update set data = excluded.data`,
    [info.id, tenantId, info.sessionId, info.parentId, info.role, JSON.stringify(info)],
  );
}

export async function putParts(q: Queryable, tenantId: string, parts: Part[]) {
  // one multi-row upsert per step
  const vals: unknown[] = [];
  const rows: string[] = [];
  for (const p of parts) {
    const b = vals.length;
    vals.push(p.id, tenantId, p.sessionId, p.messageId, p.type, JSON.stringify(p));
    rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},($${b + 6}::text)::jsonb)`);
  }
  await q.query(
    `insert into parts (id, tenant_id, session_id, message_id, type, data) values ${rows.join(",")}
     on conflict (id) do update set data = excluded.data`,
    vals,
  );
}
