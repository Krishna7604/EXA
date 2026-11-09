// Drizzle tables for the global (non-tenant, no RLS) identity tables: tenants, users,
// memberships, api_tokens, device_codes, model_backends. Mirrors migration 001.
import { bigint, boolean, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { bytea, timestamptz } from "../helpers/columns.helper.ts";

// ---------- tables ----------
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  policyVersion: bigint("policy_version", { mode: "number" }).notNull().default(1),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  authSubject: text("auth_subject").unique(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  name: text("name"),
  deviceName: text("device_name"),
  tokenHash: bytea("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  lastUsedAt: timestamptz("last_used_at"),
  expiresAt: timestamptz("expires_at"),
  revokedAt: timestamptz("revoked_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const deviceCodes = pgTable("device_codes", {
  deviceCodeHash: bytea("device_code_hash").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  tenantId: uuid("tenant_id"),
  userId: uuid("user_id"),
  status: text("status").notNull().default("pending"),
  clientName: text("client_name"),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const modelBackends = pgTable("model_backends", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  tier: text("tier").notNull(),
  free: boolean("free").notNull().default(false),
  supportsTools: boolean("supports_tools").notNull().default(false),
  contextWindow: integer("context_window").notNull(),
  priority: integer("priority").notNull().default(100),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
});
