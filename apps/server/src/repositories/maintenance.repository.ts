// Housekeeping SQL: monthly partitions for the append-only tables, and pruning of the
// short-lived session event log. Runs as the owner (crosses tenants).
import { type Db, sessionEvents } from "@exa/store";
import { lt, sql } from "drizzle-orm";

// ---------- constants ----------
const SESSION_EVENTS_RETENTION = "1 hour";

// ---------- maintenance repo ----------
export class MaintenanceRepo {
  constructor(private readonly db: Db) {}

  /** Creates usage/audit partitions for the current month and `monthsAhead` more. */
  async ensurePartitions(monthsAhead: number): Promise<void> {
    // raw: a bare plpgsql function call (no table), which the query builder can't express
    await this.db.query("select exa_ensure_partitions($1)", [monthsAhead]);
  }

  async purgeSessionEvents(): Promise<void> {
    await this.db.orm
      .delete(sessionEvents)
      .where(lt(sessionEvents.createdAt, sql`now() - ${SESSION_EVENTS_RETENTION}::interval`));
  }

  /** Drops usage/audit partitions older than `keepMonths`; returns how many were dropped. */
  async dropOldPartitions(keepMonths: number): Promise<number> {
    // raw: a bare plpgsql function call (no table), which the query builder can't express
    const rows = await this.db.query<{ n: number }>("select exa_drop_old_partitions($1) as n", [
      keepMonths,
    ]);
    return Number(rows[0]?.n ?? 0);
  }
}
