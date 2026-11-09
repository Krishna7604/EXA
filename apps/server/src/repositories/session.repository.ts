// Sessions on the server: metadata ALWAYS in Postgres; content (messages/parts) in Postgres
// only when storage_mode = 'server', otherwise in a bounded in-memory cache that disappears
// with the runtime ("none"), or not at all on the server ("local" lives on the client).
// Also holds per-session leases (one loop host at a time) and pending approvals.
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@exa/protocol";
import {
  approvals,
  type Db,
  messages,
  parts as partsTable,
  sessionEvents,
  sessionLeases,
  sessions,
  todos as todosTable,
} from "@exa/store";
import { and, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
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
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm.select().from(sessions).where(eq(sessions.id, id)),
    );
    return row ? { ...sessionFromRow(row), permissionMode: row.permissionMode } : null;
  }

  async list(
    tenantId: string,
    userId: string,
    opts: { limit?: number; parentId?: string | null; includeArchived?: boolean } = {},
  ): Promise<SessionInfo[]> {
    const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const parentFilter = opts.parentId
      ? eq(sessions.parentId, opts.parentId)
      : isNull(sessions.parentId);
    const archivedFilter = opts.includeArchived ? undefined : isNull(sessions.archivedAt);
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), parentFilter, archivedFilter))
        .orderBy(desc(sessions.updatedAt))
        .limit(limit),
    );
    return rows.map(sessionFromRow);
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
    const rows = await this.db.withTenant(tenantId, async (q) => {
      const children = q.orm
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.parentId, id));
      await q.orm
        .delete(sessionEvents)
        .where(or(eq(sessionEvents.sessionId, id), inArray(sessionEvents.sessionId, children)));
      await q.orm.delete(sessions).where(eq(sessions.parentId, id));
      return q.orm.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
    });
    return rows.length > 0;
  }

  // ---- leases (one loop host per session) ----
  async acquireLease(
    tenantId: string,
    sessionId: string,
    holder: LeaseHolder,
    ttlMs: number,
  ): Promise<number | null> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .insert(sessionLeases)
        .values({
          sessionId,
          tenantId,
          holderType: holder.type,
          holderId: holder.id,
          fencing: 1,
          expiresAt: nowPlusMs(ttlMs),
        })
        .onConflictDoUpdate({
          target: sessionLeases.sessionId,
          set: {
            holderType: sql`excluded.holder_type`,
            holderId: sql`excluded.holder_id`,
            fencing: sql`${sessionLeases.fencing} + 1`,
            expiresAt: sql`excluded.expires_at`,
          },
          // take over an expired lease, or extend our own
          setWhere: or(
            lt(sessionLeases.expiresAt, sql`now()`),
            and(
              eq(sessionLeases.holderType, sql`excluded.holder_type`),
              eq(sessionLeases.holderId, sql`excluded.holder_id`),
            ),
          ),
        })
        .returning({ fencing: sessionLeases.fencing }),
    );
    return row ? row.fencing : null;
  }

  async renewLease(
    tenantId: string,
    sessionId: string,
    holder: { type: string; id: string },
    fencing: number,
    ttlMs: number,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .update(sessionLeases)
        .set({ expiresAt: nowPlusMs(ttlMs) })
        .where(and(heldBy(sessionId, holder, fencing), gt(sessionLeases.expiresAt, sql`now()`)))
        .returning({ sessionId: sessionLeases.sessionId }),
    );
    return rows.length > 0;
  }

  async releaseLease(
    tenantId: string,
    sessionId: string,
    holder: { type: string; id: string },
    fencing: number,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .delete(sessionLeases)
        .where(heldBy(sessionId, holder, fencing))
        .returning({ sessionId: sessionLeases.sessionId }),
    );
    return rows.length > 0;
  }

  async currentLease(
    tenantId: string,
    sessionId: string,
  ): Promise<{ holderType: string; holderId: string; fencing: number } | null> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .select({
          holderType: sessionLeases.holderType,
          holderId: sessionLeases.holderId,
          fencing: sessionLeases.fencing,
        })
        .from(sessionLeases)
        .where(
          and(eq(sessionLeases.sessionId, sessionId), gt(sessionLeases.expiresAt, sql`now()`)),
        ),
    );
    return row ?? null;
  }

  // ---- approvals (server-held so any attached UI can answer) ----
  async createApproval(tenantId: string, a: NewApproval): Promise<void> {
    await this.db.withTenant(tenantId, (q) =>
      q.orm.insert(approvals).values({
        id: a.id,
        tenantId,
        sessionId: a.sessionId,
        permission: a.permission,
        tool: a.tool ?? null,
        patterns: a.patterns,
        title: a.title.slice(0, MAX_APPROVAL_TITLE_CHARS),
        expiresAt: nowPlusMs(a.ttlMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
      }),
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
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .update(approvals)
        .set({ state: reply, decidedBy: by, decidedAt: sql`now()` })
        .where(and(eq(approvals.id, id), eq(approvals.sessionId, sessionId), isOpenApproval()))
        .returning({ id: approvals.id }),
    );
    return rows.length > 0;
  }

  async approvalState(tenantId: string, id: string): Promise<string | null> {
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm.select({ state: approvals.state }).from(approvals).where(eq(approvals.id, id)),
    );
    return row?.state ?? null;
  }

  /** Open approvals of a session, oldest first, as snake_case rows (see PendingApprovalRow). */
  async pendingApprovals(tenantId: string, sessionId: string) {
    return this.db.withTenant(tenantId, (q) =>
      q.orm
        .select({
          id: approvals.id,
          permission: approvals.permission,
          tool: approvals.tool,
          patterns: approvals.patterns,
          title: approvals.title,
          requested_at: approvals.requestedAt,
        })
        .from(approvals)
        .where(and(eq(approvals.sessionId, sessionId), isOpenApproval()))
        .orderBy(approvals.requestedAt),
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
      // a client step may carry no parts (e.g. an empty reply); there is nothing to insert then
      if (parts.length) await putParts(q, tenantId, parts);
    });
  }

  async messages(tenantId: string, sessionId: string): Promise<MessageWithParts[]> {
    return this.db.withTenant(tenantId, async (q) => {
      const msgs = await q.orm
        .select({ data: messages.data })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.id);
      const parts = await q.orm
        .select({ messageId: partsTable.messageId, data: partsTable.data })
        .from(partsTable)
        .where(eq(partsTable.sessionId, sessionId))
        .orderBy(partsTable.messageId, partsTable.id);
      const byMsg = groupPartsByMessage(parts);
      return msgs.map((m) => ({ info: m.data, parts: byMsg.get(m.data.id) ?? [] }));
    });
  }

  async deleteMessages(tenantId: string, sessionId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.withTenant(tenantId, (q) =>
      q.orm.delete(messages).where(
        // compared as text so a malformed id matches nothing instead of failing the uuid cast
        and(eq(messages.sessionId, sessionId), inArray(sql`${messages.id}::text`, ids)),
      ),
    );
  }

  async putTodos(
    tenantId: string,
    sessionId: string,
    todos: Array<{ content: string; status: string; priority?: string }>,
  ): Promise<void> {
    const rows = todos.map((t, position) => ({
      tenantId,
      sessionId,
      position,
      content: t.content,
      status: t.status,
      priority: t.priority ?? null,
    }));
    await this.db.withTenant(tenantId, async (q) => {
      await q.orm.delete(todosTable).where(eq(todosTable.sessionId, sessionId));
      if (rows.length) await q.orm.insert(todosTable).values(rows);
    });
  }

  async expireApprovals(tenantId: string): Promise<number> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .update(approvals)
        .set({ state: "expired" })
        .where(and(eq(approvals.state, "pending"), lt(approvals.expiresAt, sql`now()`)))
        .returning({ id: approvals.id }),
    );
    return rows.length;
  }

  /** Content retention: delete stored conversation content older than `days` for a tenant. */
  async purgeContent(tenantId: string, days: number): Promise<number> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .delete(messages)
        .where(lt(messages.createdAt, sql`now() - make_interval(days => ${days})`))
        .returning({ id: messages.id }),
    );
    return rows.length;
  }
}

// ---------- helpers ----------
/** `now()` plus a duration in milliseconds, as a timestamptz expression. */
function nowPlusMs(ms: number): SQL {
  return sql`now() + make_interval(secs => ${ms}::double precision / 1000)`;
}

/** The lease row of `sessionId`, if `holder` still holds it under this fencing token. */
function heldBy(
  sessionId: string,
  holder: { type: string; id: string },
  fencing: number,
): SQL | undefined {
  return and(
    eq(sessionLeases.sessionId, sessionId),
    eq(sessionLeases.holderType, holder.type),
    eq(sessionLeases.holderId, holder.id),
    eq(sessionLeases.fencing, fencing),
  );
}

/** Still waiting for an answer and not yet timed out. */
function isOpenApproval(): SQL | undefined {
  return and(eq(approvals.state, "pending"), gt(approvals.expiresAt, sql`now()`));
}

function groupPartsByMessage(rows: Array<{ messageId: string; data: Part }>): Map<string, Part[]> {
  const byMsg = new Map<string, Part[]>();
  for (const p of rows) {
    const a = byMsg.get(p.messageId) ?? [];
    a.push(p.data);
    byMsg.set(p.messageId, a);
  }
  return byMsg;
}
