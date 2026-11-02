// Usage and audit rows as recorded by the server (buffered, then written in batches).

// ---------- types ----------
export interface UsageRow {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  modelRequested: string;
  modelUsed: string;
  keySource: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  latencyMs: number;
  status: string;
  time: number;
}

export interface AuditRow {
  tenantId: string;
  actorUserId?: string;
  device?: string;
  sessionId?: string;
  action: string;
  target?: string;
  decision?: string;
  meta?: Record<string, unknown>;
  time?: number;
}
