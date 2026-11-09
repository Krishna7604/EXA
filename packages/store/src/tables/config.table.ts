// Drizzle tables for tenant configuration: projects, settings, permission rules, BYOK provider
// keys, quotas and encrypted secrets. Mirrors migration 001 (all have RLS on tenant_id).
import {
  bigint,
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, jsonb, timestamptz } from "../helpers/columns.helper.ts";

// ---------- tables ----------
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const settings = pgTable(
  "settings",
  {
    tenantId: uuid("tenant_id").notNull(),
    scope: text("scope").notNull(),
    scopeId: uuid("scope_id").notNull(),
    key: text("key").notNull(),
    value: jsonb<unknown>("value").notNull(),
    locked: boolean("locked").notNull().default(false),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scope, t.scopeId, t.key] })],
);

export const permissionRules = pgTable("permission_rules", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id").notNull(),
  permission: text("permission").notNull(),
  pattern: text("pattern").notNull(),
  action: text("action").notNull(),
  locked: boolean("locked").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const providerKeys = pgTable("provider_keys", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  ownerScope: text("owner_scope").notNull(),
  ownerId: uuid("owner_id").notNull(),
  provider: text("provider").notNull(),
  label: text("label"),
  ciphertext: bytea("ciphertext").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  keyVersion: integer("key_version").notNull(),
  last4: text("last4"),
  lastUsedAt: timestamptz("last_used_at"),
  revokedAt: timestamptz("revoked_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const quotas = pgTable(
  "quotas",
  {
    tenantId: uuid("tenant_id").notNull(),
    subjectScope: text("subject_scope").notNull(),
    subjectId: uuid("subject_id").notNull(),
    period: text("period").notNull(),
    maxTokens: bigint("max_tokens", { mode: "number" }),
    maxCostUsd: numeric("max_cost_usd", { mode: "number" }),
    maxRequests: integer("max_requests"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.subjectScope, t.subjectId, t.period] })],
);

export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  keyVersion: integer("key_version").notNull(),
});
