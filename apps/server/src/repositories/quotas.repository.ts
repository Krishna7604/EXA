// Token / spend / request quotas per tenant or user, checked against the usage rollups that
// TelemetryWriter maintains.
import { type Db, type DbTx, quotas, usageRollups } from "@exa/store";
import { and, eq, or, sql } from "drizzle-orm";
import type { QuotaLimits, QuotaUsageRow } from "../models/quota.model.ts";

// ---------- constants ----------
/** The rollup period a quota row is measured against: today, or this month. */
const CURRENT_PERIOD_START = sql`case ${quotas.period} when 'day' then current_date
  else date_trunc('month', current_date)::date end`;

// ---------- quotas repo ----------
export class QuotasRepo {
  constructor(private readonly db: Db) {}

  async set(tenantId: string, q: QuotaLimits): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.orm
        .insert(quotas)
        .values({
          tenantId,
          subjectScope: q.subjectScope,
          subjectId: q.subjectId,
          period: q.period,
          maxTokens: q.maxTokens ?? null,
          maxCostUsd: q.maxCostUsd ?? null,
          maxRequests: q.maxRequests ?? null,
        })
        .onConflictDoUpdate({
          target: [quotas.tenantId, quotas.subjectScope, quotas.subjectId, quotas.period],
          set: {
            maxTokens: sql`excluded.max_tokens`,
            maxCostUsd: sql`excluded.max_cost_usd`,
            maxRequests: sql`excluded.max_requests`,
          },
        }),
    );
  }

  /** Null when within quota, else a human message. */
  async exceeded(tenantId: string, userId: string): Promise<string | null> {
    const rows = await this.db.withTenant(tenantId, (q) => quotaUsage(q, tenantId, userId));
    for (const r of rows) {
      const message = exceededMessage(r);
      if (message) return message;
    }
    return null;
  }
}

// ---------- helpers ----------
/** The tenant's and the user's quotas, each joined with its current-period usage. */
async function quotaUsage(q: DbTx, tenantId: string, userId: string): Promise<QuotaUsageRow[]> {
  const rows = await q.orm
    .select({
      subject_scope: quotas.subjectScope,
      period: quotas.period,
      max_tokens: quotas.maxTokens,
      max_cost_usd: quotas.maxCostUsd,
      max_requests: quotas.maxRequests,
      tokens: sql`coalesce(${usageRollups.tokens}, 0)`,
      cost: sql`coalesce(${usageRollups.costUsd}, 0)`,
      requests: sql`coalesce(${usageRollups.requests}, 0)`,
    })
    .from(quotas)
    .leftJoin(
      usageRollups,
      and(
        eq(usageRollups.tenantId, quotas.tenantId),
        eq(usageRollups.subjectScope, quotas.subjectScope),
        eq(usageRollups.subjectId, quotas.subjectId),
        eq(usageRollups.period, quotas.period),
        eq(usageRollups.periodStart, CURRENT_PERIOD_START),
      ),
    )
    .where(
      or(
        and(eq(quotas.subjectScope, "tenant"), eq(quotas.subjectId, tenantId)),
        and(eq(quotas.subjectScope, "user"), eq(quotas.subjectId, userId)),
      ),
    );
  return rows as QuotaUsageRow[];
}

function exceededMessage(r: QuotaUsageRow): string | null {
  const who = r.subject_scope === "tenant" ? "Organization" : "Your";
  if (isAtLimit(r.tokens, r.max_tokens)) return `${who} ${r.period}ly token quota is used up`;
  if (isAtLimit(r.cost, r.max_cost_usd)) return `${who} ${r.period}ly spend quota is used up`;
  if (isAtLimit(r.requests, r.max_requests)) return `${who} ${r.period}ly request quota is used up`;
  return null;
}

/** A null limit means "unlimited". */
function isAtLimit(used: unknown, limit: unknown): boolean {
  return limit !== null && Number(used) >= Number(limit);
}
