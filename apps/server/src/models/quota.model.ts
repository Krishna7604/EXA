// Quota limits per tenant or user, and the joined quota/usage row they are checked against.

// ---------- types ----------
export interface QuotaLimits {
  subjectScope: "tenant" | "user";
  subjectId: string;
  period: "day" | "month";
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  maxRequests?: number | null;
}

/** A quota joined with the current period's usage (numeric columns may arrive as strings). */
export interface QuotaUsageRow {
  subject_scope: "tenant" | "user";
  period: string;
  max_tokens: unknown;
  max_cost_usd: unknown;
  max_requests: unknown;
  tokens: unknown;
  cost: unknown;
  requests: unknown;
}
