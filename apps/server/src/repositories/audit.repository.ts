// Audit log (append-only, month-partitioned): batched inserts and the trail admins read.
import { newId } from "@exa/protocol";
import { auditLog, type Db, type DbTx } from "@exa/store";
import { desc, eq } from "drizzle-orm";
import { isUuid } from "../helpers/sql-values.helper.ts";
import type { AuditRow } from "../models/telemetry.model.ts";

// ---------- constants ----------
const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_TARGET_CHARS = 1000;

// ---------- reads ----------
/** Newest entries first, as snake_case rows (the API returns them as-is). */
export async function auditTrail(
  db: Db,
  tenantId: string,
  opts: { sessionId?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? DEFAULT_AUDIT_LIMIT;
  return db.withTenant(tenantId, (q) =>
    q.orm
      .select({
        ts: auditLog.ts,
        actor_user_id: auditLog.actorUserId,
        device: auditLog.device,
        session_id: auditLog.sessionId,
        action: auditLog.action,
        target: auditLog.target,
        decision: auditLog.decision,
      })
      .from(auditLog)
      .where(opts.sessionId ? eq(auditLog.sessionId, opts.sessionId) : undefined)
      .orderBy(desc(auditLog.ts))
      .limit(limit),
  );
}

// ---------- writes ----------
export async function insertAuditRows(q: DbTx, tenantId: string, rows: AuditRow[]): Promise<void> {
  await q.orm.insert(auditLog).values(
    rows.map((a) => ({
      id: newId(),
      tenantId,
      actorUserId: isUuid(a.actorUserId) ? a.actorUserId : null,
      device: a.device ?? null,
      sessionId: isUuid(a.sessionId) ? a.sessionId : null,
      action: a.action,
      target: a.target?.slice(0, MAX_AUDIT_TARGET_CHARS) ?? null,
      decision: a.decision ?? null,
      meta: a.meta ?? null,
      ts: new Date(a.time!),
    })),
  );
}
