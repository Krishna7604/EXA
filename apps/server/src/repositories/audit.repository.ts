// Audit log (append-only, month-partitioned): batched inserts and the trail admins read.
import { newId } from "@exa/protocol";
import type { Db, Queryable } from "@exa/store";
import { isUuid } from "../helpers/sql-values.helper.ts";
import type { AuditRow } from "../models/telemetry.model.ts";

// ---------- constants ----------
const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_TARGET_CHARS = 1000;

// ---------- reads ----------
export async function auditTrail(
  db: Db,
  tenantId: string,
  opts: { sessionId?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? DEFAULT_AUDIT_LIMIT;
  return db.withTenant(tenantId, (q) =>
    q.query<any>(
      `select ts, actor_user_id, device, session_id, action, target, decision from audit_log
       ${opts.sessionId ? "where session_id = $2" : ""} order by ts desc limit $1`,
      opts.sessionId ? [limit, opts.sessionId] : [limit],
    ),
  );
}

// ---------- writes ----------
export async function insertAuditRows(
  q: Queryable,
  tenantId: string,
  rows: AuditRow[],
): Promise<void> {
  const vals: unknown[] = [];
  const tuples: string[] = [];
  for (const a of rows) {
    const b = vals.length;
    vals.push(
      newId(),
      tenantId,
      isUuid(a.actorUserId) ? a.actorUserId : null,
      a.device ?? null,
      isUuid(a.sessionId) ? a.sessionId : null,
      a.action,
      a.target?.slice(0, MAX_AUDIT_TARGET_CHARS) ?? null,
      a.decision ?? null,
      a.meta ? JSON.stringify(a.meta) : null,
      new Date(a.time!).toISOString(),
    );
    tuples.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},($${b + 9}::text)::jsonb,$${b + 10})`,
    );
  }
  await q.query(
    `insert into audit_log (id, tenant_id, actor_user_id, device, session_id, action, target, decision, meta, ts) values ${tuples.join(",")}`,
    vals,
  );
}
