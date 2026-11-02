// Token / spend / request quotas per tenant or user, checked against the usage rollups that
// TelemetryWriter maintains.
import type { Db } from "@exa/store";
import type { QuotaLimits, QuotaUsageRow } from "../models/quota.model.ts";

// ---------- quotas repo ----------
export class QuotasRepo {
  constructor(private readonly db: Db) {}

  async set(tenantId: string, q: QuotaLimits): Promise<void> {
    await this.db.withTenant(tenantId, (x) =>
      x.query(
        `insert into quotas (tenant_id, subject_scope, subject_id, period, max_tokens, max_cost_usd, max_requests) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, subject_scope, subject_id, period) do update set max_tokens = excluded.max_tokens,
           max_cost_usd = excluded.max_cost_usd, max_requests = excluded.max_requests`,
        [
          tenantId,
          q.subjectScope,
          q.subjectId,
          q.period,
          q.maxTokens ?? null,
          q.maxCostUsd ?? null,
          q.maxRequests ?? null,
        ],
      ),
    );
  }

  /** Null when within quota, else a human message. */
  async exceeded(tenantId: string, userId: string): Promise<string | null> {
    const rows = await this.db.withTenant(tenantId, (q) =>
      q.query<QuotaUsageRow>(
        `select qt.subject_scope, qt.period, qt.max_tokens, qt.max_cost_usd, qt.max_requests,
                coalesce(r.tokens, 0) as tokens, coalesce(r.cost_usd, 0) as cost, coalesce(r.requests, 0) as requests
         from quotas qt
         left join usage_rollups r on r.tenant_id = qt.tenant_id and r.subject_scope = qt.subject_scope and r.subject_id = qt.subject_id
           and r.period = qt.period
           and r.period_start = case qt.period when 'day' then current_date else date_trunc('month', current_date)::date end
         where (qt.subject_scope = 'tenant' and qt.subject_id = $1) or (qt.subject_scope = 'user' and qt.subject_id = $2)`,
        [tenantId, userId],
      ),
    );
    for (const r of rows) {
      const message = exceededMessage(r);
      if (message) return message;
    }
    return null;
  }
}

// ---------- helpers ----------
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
