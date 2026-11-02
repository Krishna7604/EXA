// Usage events (append-only, month-partitioned) and the day/month rollups quota checks read.
import { newId } from "@exa/protocol";
import type { Db, Queryable } from "@exa/store";
import { isUuid, placeholders } from "../helpers/sql-values.helper.ts";
import type { UsageRow } from "../models/telemetry.model.ts";

// ---------- constants ----------
const DEFAULT_SUMMARY_DAYS = 30;
/** Values per usage_events row (must match the column list in insertUsageEvents). */
const USAGE_COLUMN_COUNT = 16;
const ROLLUP_PERIODS = ["day", "month"];

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
export async function usageSummary(
  db: Db,
  tenantId: string,
  opts: { userId?: string; days?: number } = {},
) {
  const days = opts.days ?? DEFAULT_SUMMARY_DAYS;
  return db.withTenant(tenantId, (q) =>
    q.query<any>(
      `select date_trunc('day', ts)::date as day, model_used, count(*)::int as requests,
              sum(input_tokens)::bigint as input, sum(output_tokens)::bigint as output, sum(cost_usd)::float8 as cost
       from usage_events where ts > now() - make_interval(days => $1) ${opts.userId ? "and user_id = $2" : ""}
       group by 1, 2 order by 1 desc, 2`,
      opts.userId ? [days, opts.userId] : [days],
    ),
  );
}

// ---------- writes ----------
export async function insertUsageEvents(
  q: Queryable,
  tenantId: string,
  rows: UsageRow[],
): Promise<void> {
  const vals: unknown[] = [];
  const tuples: string[] = [];
  for (const u of rows) {
    const b = vals.length;
    vals.push(
      newId(),
      tenantId,
      isUuid(u.userId) ? u.userId : null,
      isUuid(u.sessionId) ? u.sessionId : null,
      u.modelRequested,
      u.modelUsed,
      u.keySource,
      u.input,
      u.output,
      u.reasoning,
      u.cacheRead,
      u.cacheWrite,
      u.costUsd,
      u.latencyMs,
      u.status,
      new Date(u.time).toISOString(),
    );
    tuples.push(placeholders(b, USAGE_COLUMN_COUNT));
  }
  await q.query(
    `insert into usage_events (id, tenant_id, user_id, session_id, model_requested, model_used, key_source, input_tokens, output_tokens,
                  reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, status, ts) values ${tuples.join(",")}`,
    vals,
  );
}

/** Rollups: tenant + user, day + month. */
export async function upsertRollups(
  q: Queryable,
  tenantId: string,
  rows: UsageRow[],
): Promise<void> {
  for (const a of aggregateBySubject(tenantId, rows).values()) {
    for (const period of ROLLUP_PERIODS) {
      await q.query(
        `insert into usage_rollups (tenant_id, subject_scope, subject_id, period, period_start, tokens, cost_usd, requests)
                     values ($1,$2,$3,$4, case $4 when 'day' then current_date else date_trunc('month', current_date)::date end, $5,$6,$7)
                     on conflict (tenant_id, subject_scope, subject_id, period, period_start) do update set
                       tokens = usage_rollups.tokens + excluded.tokens, cost_usd = usage_rollups.cost_usd + excluded.cost_usd,
                       requests = usage_rollups.requests + excluded.requests`,
        [tenantId, a.scope, a.id, period, a.tokens, a.cost, a.n],
      );
    }
  }
}

// ---------- helpers ----------
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
