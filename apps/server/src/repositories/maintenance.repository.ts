// Housekeeping SQL: monthly partitions for the append-only tables, and pruning of the
// short-lived session event log. Runs as the owner (crosses tenants).
import type { Queryable } from "@exa/store";

// ---------- constants ----------
const SESSION_EVENTS_RETENTION = "1 hour";

// ---------- maintenance repo ----------
export class MaintenanceRepo {
  constructor(private readonly db: Queryable) {}

  /** Creates usage/audit partitions for the current month and `monthsAhead` more. */
  async ensurePartitions(monthsAhead: number): Promise<void> {
    await this.db.query(`select exa_ensure_partitions(${monthsAhead})`);
  }

  async purgeSessionEvents(): Promise<void> {
    await this.db.query(
      `delete from session_events where created_at < now() - interval '${SESSION_EVENTS_RETENTION}'`,
    );
  }

  /** Drops usage/audit partitions older than `keepMonths`; returns how many were dropped. */
  async dropOldPartitions(keepMonths: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>("select exa_drop_old_partitions($1) as n", [
      keepMonths,
    ]);
    return Number(rows[0]?.n ?? 0);
  }
}
