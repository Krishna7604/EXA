// Drizzle tables for sessions and everything hanging off one: leases, approvals, stored
// conversation content (messages, parts), todos and the short-lived event outbox.
// Mirrors migrations 001 and 003 (sessions.task_id).
import type { MessageInfo, Part, SessionInfo } from "@exa/protocol";
import { bigint, integer, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "../helpers/columns.helper.ts";

// ---------- tables ----------
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  projectId: uuid("project_id"),
  parentId: uuid("parent_id"),
  /** Set when the session is a scheduled task's run. */
  taskId: uuid("task_id"),
  title: text("title"),
  directory: text("directory"),
  agent: text("agent").notNull().default("build"),
  model: text("model").notNull(),
  loopHost: text("loop_host").notNull(),
  storageMode: text("storage_mode").notNull(),
  permissionMode: text("permission_mode").notNull().default("default"),
  status: text("status").notNull().default("active"),
  revert: jsonb<SessionInfo["revert"]>("revert"),
  tokensInput: bigint("tokens_input", { mode: "number" }).notNull().default(0),
  tokensOutput: bigint("tokens_output", { mode: "number" }).notNull().default(0),
  tokensReasoning: bigint("tokens_reasoning", { mode: "number" }).notNull().default(0),
  tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }).notNull().default(0),
  tokensCacheWrite: bigint("tokens_cache_write", { mode: "number" }).notNull().default(0),
  costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  archivedAt: timestamptz("archived_at"),
});

export const sessionLeases = pgTable("session_leases", {
  sessionId: uuid("session_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  holderType: text("holder_type").notNull(),
  holderId: text("holder_id").notNull(),
  fencing: bigint("fencing", { mode: "number" }).notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  permission: text("permission").notNull(),
  tool: text("tool"),
  patterns: text("patterns").array().notNull(),
  title: text("title").notNull(),
  state: text("state").notNull().default("pending"),
  decidedBy: uuid("decided_by"),
  requestedAt: timestamptz("requested_at").notNull().defaultNow(),
  decidedAt: timestamptz("decided_at"),
  expiresAt: timestamptz("expires_at").notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  parentId: uuid("parent_id"),
  role: text("role").notNull(),
  data: jsonb<MessageInfo>("data").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const parts = pgTable("parts", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  messageId: uuid("message_id").notNull(),
  type: text("type").notNull(),
  data: jsonb<Part>("data").notNull(),
  blobRef: text("blob_ref"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const todos = pgTable(
  "todos",
  {
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull(),
    priority: text("priority"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.position] })],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb<unknown>("data").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);
