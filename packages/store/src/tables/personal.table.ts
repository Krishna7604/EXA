// Drizzle tables for the personal-agent features: long-term memories, scheduled tasks and
// their runs. Mirrors migration 003 (all have RLS on tenant_id).
import { sql } from "drizzle-orm";
import { boolean, customType, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "../helpers/columns.helper.ts";

// ---------- constants ----------
/** Text-search config shared by the memory index and chat search. */
export const SEARCH_CONFIG = "english";

// ---------- columns ----------
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// ---------- tables ----------
/** One remembered fact or preference about a user, filed under a short topic. */
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  topic: text("topic").notNull(),
  content: text("content").notNull(),
  /** The chat the memory was learned in (null when added by hand). */
  sourceSessionId: uuid("source_session_id"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  search: tsvector("search").generatedAlwaysAs(
    sql`to_tsvector('english', topic || ' ' || content)`,
  ),
});

/** A prompt the server runs on a cron schedule, as the user who owns it. */
export const scheduledTasks = pgTable("scheduled_tasks", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  /** Five-field cron expression, evaluated in `timezone`. */
  schedule: text("schedule").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  /** Null: the user's default model / the default agent. */
  model: text("model"),
  agent: text("agent"),
  enabled: boolean("enabled").notNull().default(true),
  /** Null while disabled. The scheduler claims rows whose time has come. */
  nextRunAt: timestamptz("next_run_at"),
  lastRunAt: timestamptz("last_run_at"),
  lastStatus: text("last_status"),
  lastSessionId: uuid("last_session_id"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** One execution of a scheduled task; its conversation is the session `session_id`. */
export const taskRuns = pgTable("task_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  sessionId: uuid("session_id"),
  /** "schedule" or "manual". */
  trigger: text("trigger").notNull(),
  /** "running" | "ok" | "error". */
  status: text("status").notNull(),
  error: text("error"),
  costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
  finishedAt: timestamptz("finished_at"),
});
