// Usage events (append-only, month-partitioned) and the day/month rollups quota checks read.
import { newId } from "@exa/protocol";
import { type Db, type DbTx, usageEvents, usageRollups } from "@exa/store";
import { and, desc, eq, gt, type SQL, sql } from "drizzle-orm";
import { isUuid } from "../helpers/sql-values.helper.ts";
import type { UsageRow } from "../models/telemetry.model.ts";

// ---------- constants ----------
const DEFAULT_SUMMARY_DAYS = 30;
const ROLLUP_PERIODS = ["day", "month"];
/** Day bucket of a usage event. PGlite returns a `date` as text, so it is mapped to a Date. */
const USAGE_DAY = sql<Date>`date_trunc('day', ${usageEvents.ts})::date`.mapWith(
  (v: Date | string) => new Date(v),
);

// ---------- types ----------
/** Rollup totals for one subject (the tenant, or one user) within a flush. */
interface SubjectTotals {
  scope: string;
  id: string;
  tokens: number;
  cost: number;
  n: number;
}

// ---------- reads ----------
/**
 * Per day and model, newest day first, as snake_case rows (the API returns them as-is).
 * `input` / `output` are int8 sums, so they arrive as the driver gives them.
 */
export async function usageSummary(
  db: Db,
  tenantId: string,
  opts: { userId?: string; days?: number } = {},
) {
  const days = opts.days ?? DEFAULT_SUMMARY_DAYS;
  const byUser = opts.userId ? eq(usageEvents.userId, opts.userId) : undefined;
  return db.withTenant(tenantId, (q) =>
    q.orm
      .select({
        day: USAGE_DAY,
        model_used: usageEvents.modelUsed,
        requests: sql<number>`count(*)::int`,
        input: sql<number | string>`sum(${usageEvents.inputTokens})::bigint`,
        output: sql<number | string>`sum(${usageEvents.outputTokens})::bigint`,
        cost: sql<number>`sum(${usageEvents.costUsd})::float8`,
      })
      .from(usageEvents)
      .where(and(gt(usageEvents.ts, sql`now() - make_interval(days => ${days})`), byUser))
      .groupBy(USAGE_DAY, usageEvents.modelUsed)
      .orderBy(desc(USAGE_DAY), usageEvents.modelUsed),
  );
}

// ---------- writes ----------
export async function insertUsageEvents(
  q: DbTx,
  tenantId: string,
  rows: UsageRow[],
): Promise<void> {
  await q.orm.insert(usageEvents).values(
    rows.map((u) => ({
      id: newId(),
      tenantId,
      userId: isUuid(u.userId) ? u.userId : null,
      sessionId: isUuid(u.sessionId) ? u.sessionId : null,
      modelRequested: u.modelRequested,
      modelUsed: u.modelUsed,
      keySource: u.keySource,
      inputTokens: u.input,
      outputTokens: u.output,
      reasoningTokens: u.reasoning,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      costUsd: u.costUsd,
      latencyMs: u.latencyMs,
      status: u.status,
      ts: new Date(u.time),
    })),
  );
}

/** Rollups: tenant + user, day + month. */
export async function upsertRollups(q: DbTx, tenantId: string, rows: UsageRow[]): Promise<void> {
  for (const a of aggregateBySubject(tenantId, rows).values()) {
    for (const period of ROLLUP_PERIODS) {
      await q.orm
        .insert(usageRollups)
        .values({
          tenantId,
          subjectScope: a.scope,
          subjectId: a.id,
          period,
          periodStart: periodStart(period),
          tokens: a.tokens,
          costUsd: a.cost,
          requests: a.n,
        })
        .onConflictDoUpdate({
          target: [
            usageRollups.tenantId,
            usageRollups.subjectScope,
            usageRollups.subjectId,
            usageRollups.period,
            usageRollups.periodStart,
          ],
          set: {
            tokens: sql`${usageRollups.tokens} + excluded.tokens`,
            costUsd: sql`${usageRollups.costUsd} + excluded.cost_usd`,
            requests: sql`${usageRollups.requests} + excluded.requests`,
          },
        });
    }
  }
}

// ---------- helpers ----------
/** First day of the current `period` ("day" or "month"). */
function periodStart(period: string): SQL {
  if (period === "day") return sql`current_date`;
  return sql`date_trunc('month', current_date)::date`;
}

function aggregateBySubject(tenantId: string, rows: UsageRow[]): Map<string, SubjectTotals> {
  const agg = new Map<string, SubjectTotals>();
  for (const u of rows) {
    const tokens = u.input + u.output + u.cacheWrite;
    const subjects: Array<[string, string]> = [["tenant", tenantId]];
    if (isUuid(u.userId)) subjects.push(["user", u.userId!]);
    for (const [scope, id] of subjects) {
      const k = `${scope}:${id}`;
      const a = agg.get(k) ?? { scope, id, tokens: 0, cost: 0, n: 0 };
      a.tokens += tokens;
      a.cost += u.costUsd;
      a.n += 1;
      agg.set(k, a);
    }
  }
  return agg;
}
