// Drizzle tables for usage and audit: the append-only, month-partitioned usage_events and
// audit_log, plus the usage_rollups that back quota checks. Mirrors migration 001.
import {
  bigint,
  date,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "../helpers/columns.helper.ts";

// ---------- tables ----------
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id"),
    sessionId: uuid("session_id"),
    modelRequested: text("model_requested").notNull(),
    modelUsed: text("model_used").notNull(),
    keySource: text("key_source").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.ts] })],
);

export const usageRollups = pgTable(
  "usage_rollups",
  {
    tenantId: uuid("tenant_id").notNull(),
    subjectScope: text("subject_scope").notNull(),
    subjectId: uuid("subject_id").notNull(),
    period: text("period").notNull(),
    periodStart: date("period_start").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [t.tenantId, t.subjectScope, t.subjectId, t.period, t.periodStart],
    }),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    device: text("device"),
    sessionId: uuid("session_id"),
    action: text("action").notNull(),
    target: text("target"),
    decision: text("decision"),
    meta: jsonb<Record<string, unknown>>("meta"),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.ts] })],
);
