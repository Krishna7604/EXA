// Sessions on the server: metadata ALWAYS in Postgres; content (messages/parts) in Postgres
// only when storage_mode = 'server', otherwise in a bounded in-memory cache that disappears
// with the runtime ("none"), or not at all on the server ("local" lives on the client).
// Also holds per-session leases (one loop host at a time) and pending approvals.
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@exa/protocol";
import type { Db } from "@exa/store";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../constants/limits.constants.ts";
import type { LeaseHolder, NewApproval, SessionMeta } from "../models/session.model.ts";
import {
  insertSession,
  putMessage,
  putParts,
  sessionFromRow,
  updateSession,
} from "./session-sql.repository.ts";

// ---------- constants ----------
const DEFAULT_LIST_LIMIT = 50;
const MAX_APPROVAL_TITLE_CHARS = 500;

// ---------- session repo ----------
export class SessionRepo {
  constructor(private readonly db: Db) {}

  async create(info: SessionInfo, permissionMode = "default"): Promise<void> {
    await this.db.withTenant(info.tenantId, (q) => insertSession(q, info, permissionMode));
  }

  async get(tenantId: string, id: string): Promise<SessionMeta | null> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<any>(`select * from sessions where id = $1`, [id]),
    );
    return r[0] ? { ...sessionFromRow(r[0]), permissionMode: r[0].permission_mode } : null;
  }

  async list(
    tenantId: string,
    userId: string,
    opts: { limit?: number; parentId?: string | null; includeArchived?: boolean } = {},
  ): Promise<SessionInfo[]> {
    const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const parentFilter = opts.parentId ? "parent_id = $3" : "parent_id is null";
    const archivedFilter = opts.includeArchived ? "" : "and archived_at is null";
    const params = opts.parentId ? [userId, limit, opts.parentId] : [userId, limit];
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<any>(
        `select * from sessions where user_id = $1 and ${parentFilter}
         ${archivedFilter} order by updated_at desc limit $2`,
        params,
      ),
    );
    return r.map(sessionFromRow);
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<SessionInfo> & { permissionMode?: string },
  ): Promise<void> {
    await this.db.withTenant(tenantId, (q) => updateSession(q, id, patch));
  }

  /** "Forget": removes the session and everything hanging off it. */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const r = await this.db.withTenant(tenantId, async (q) => {
      await q.query(
        `delete from session_events where session_id = $1 or session_id in (select id from sessions where parent_id = $1)`,
        [id],
      );
      await q.query(`delete from sessions where parent_id = $1`, [id]);
      return q.query(`delete from sessions where id = $1 returning id`, [id]);
    });
    return r.length > 0;
  }

  // ---- leases (one loop host per session) ----
  async acquireLease(
    tenantId: string,
    sessionId: string,
    holder: LeaseHolder,
    ttlMs: number,
  ): Promise<number | null> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<{ fencing: string }>(
        `insert into session_leases (session_id, tenant_id, holder_type, holder_id, fencing, expires_at)
         values ($1, $2, $3, $4, 1, now() + make_interval(secs => $5::double precision / 1000))
         on conflict (session_id) do update set holder_type = excluded.holder_type, holder_id = excluded.holder_id,
           fencing = session_leases.fencing + 1, expires_at = excluded.expires_at
         where session_leases.expires_at < now()
            or (session_leases.holder_type = excluded.holder_type and session_leases.holder_id = excluded.holder_id)
         returning fencing`,
        [sessionId, tenantId, holder.type, holder.id, ttlMs],
      ),
    );
    return r[0] ? Number(r[0].fencing) : null;
  }

  async renewLease(
    tenantId: string,
    sessionId: string,
    holder: { type: string; id: string },
    fencing: number,
    ttlMs: number,
  ): Promise<boolean> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query(
        `update session_leases set expires_at = now() + make_interval(secs => $5::double precision / 1000)
         where session_id = $1 and holder_type = $2 and holder_id = $3 and fencing = $4 and expires_at > now() returning session_id`,
        [sessionId, holder.type, holder.id, fencing, ttlMs],
      ),
    );
    return r.length > 0;
  }

  async releaseLease(
    tenantId: string,
    sessionId: string,
    holder: { type: string; id: string },
    fencing: number,
  ): Promise<boolean> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query(
        `delete from session_leases where session_id = $1 and holder_type = $2 and holder_id = $3 and fencing = $4 returning session_id`,
        [sessionId, holder.type, holder.id, fencing],
      ),
    );
    return r.length > 0;
  }

  async currentLease(
    tenantId: string,
    sessionId: string,
  ): Promise<{ holderType: string; holderId: string; fencing: number } | null> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<any>(
        `select holder_type, holder_id, fencing from session_leases where session_id = $1 and expires_at > now()`,
        [sessionId],
      ),
    );
    return r[0]
      ? { holderType: r[0].holder_type, holderId: r[0].holder_id, fencing: Number(r[0].fencing) }
      : null;
  }

  // ---- approvals (server-held so any attached UI can answer) ----
  async createApproval(tenantId: string, a: NewApproval): Promise<void> {
    await this.db.withTenant(tenantId, (q) =>
      q.query(
        `insert into approvals (id, tenant_id, session_id, permission, tool, patterns, title, expires_at)
         values ($1,$2,$3,$4,$5,coalesce((select array_agg(x) from jsonb_array_elements_text((($6)::text)::jsonb) x), '{}'),$7, now() + make_interval(secs => $8::double precision / 1000))`,
        [
          a.id,
          tenantId,
          a.sessionId,
          a.permission,
          a.tool ?? null,
          JSON.stringify(a.patterns),
          a.title.slice(0, MAX_APPROVAL_TITLE_CHARS),
          a.ttlMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        ],
      ),
    );
  }

  /** Decide a pending approval of THIS session (first answer wins). */
  async decideApproval(
    tenantId: string,
    sessionId: string,
    id: string,
    reply: "once" | "always" | "reject",
    by: string | null,
  ): Promise<boolean> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<any>(
        `update approvals set state = $3, decided_by = $4, decided_at = now()
         where id = $1 and session_id = $2 and state = 'pending' and expires_at > now() returning id`,
        [id, sessionId, reply, by],
      ),
    );
    return r.length > 0;
  }

  async approvalState(tenantId: string, id: string): Promise<string | null> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query<{ state: string }>(`select state from approvals where id = $1`, [id]),
    );
    return r[0]?.state ?? null;
  }

  async pendingApprovals(tenantId: string, sessionId: string) {
    return this.db.withTenant(tenantId, (q) =>
      q.query<any>(
        `select id, permission, tool, patterns, title, requested_at from approvals where session_id = $1 and state = 'pending' and expires_at > now() order by requested_at`,
        [sessionId],
      ),
    );
  }

  // ---- content (storage_mode = server) ----
  async putMessage(tenantId: string, info: MessageInfo): Promise<void> {
    await this.db.withTenant(tenantId, (q) => putMessage(q, tenantId, info));
  }

  async putParts(tenantId: string, parts: Part[]): Promise<void> {
    if (!parts.length) return;
    await this.db.withTenant(tenantId, (q) => putParts(q, tenantId, parts));
  }

  /** Persist one step atomically (message + its final parts) — used for client-loop ingest. */
  async putStep(tenantId: string, info: MessageInfo, parts: Part[]): Promise<void> {
    await this.db.withTenant(tenantId, async (q) => {
      await putMessage(q, tenantId, info);
      await putParts(q, tenantId, parts);
    });
  }

  async messages(tenantId: string, sessionId: string): Promise<MessageWithParts[]> {
    return this.db.withTenant(tenantId, async (q) => {
      const msgs = await q.query<any>(
        `select data from messages where session_id = $1 order by id`,
        [sessionId],
      );
      const parts = await q.query<any>(
        `select message_id, data from parts where session_id = $1 order by message_id, id`,
        [sessionId],
      );
      const byMsg = groupPartsByMessage(parts);
      return msgs.map((m) => ({
        info: m.data as MessageInfo,
        parts: byMsg.get((m.data as MessageInfo).id) ?? [],
      }));
    });
  }

  async deleteMessages(tenantId: string, sessionId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.withTenant(tenantId, (q) =>
      q.query(
        `delete from messages where session_id = $1 and id::text in (select jsonb_array_elements_text(($2::text)::jsonb))`,
        [sessionId, JSON.stringify(ids)],
      ),
    );
  }

  async putTodos(
    tenantId: string,
    sessionId: string,
    todos: Array<{ content: string; status: string; priority?: string }>,
  ): Promise<void> {
    await this.db.withTenant(tenantId, async (q) => {
      await q.query(`delete from todos where session_id = $1`, [sessionId]);
      for (let i = 0; i < todos.length; i++) {
        await q.query(
          `insert into todos (tenant_id, session_id, position, content, status, priority) values ($1,$2,$3,$4,$5,$6)`,
          [tenantId, sessionId, i, todos[i].content, todos[i].status, todos[i].priority ?? null],
        );
      }
    });
  }

  async expireApprovals(tenantId: string): Promise<number> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query(
        `update approvals set state = 'expired' where state = 'pending' and expires_at < now() returning id`,
      ),
    );
    return r.length;
  }

  /** Content retention: delete stored conversation content older than `days` for a tenant. */
  async purgeContent(tenantId: string, days: number): Promise<number> {
    const r = await this.db.withTenant(tenantId, (q) =>
      q.query(
        `delete from messages where created_at < now() - make_interval(days => $1) returning id`,
        [days],
      ),
    );
    return r.length;
  }
}

// ---------- helpers ----------
function groupPartsByMessage(
  rows: Array<{ message_id: string; data: unknown }>,
): Map<string, Part[]> {
  const byMsg = new Map<string, Part[]>();
  for (const p of rows) {
    const a = byMsg.get(p.message_id) ?? [];
    a.push(p.data as Part);
    byMsg.set(p.message_id, a);
  }
  return byMsg;
}
