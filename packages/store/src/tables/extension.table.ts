// Drizzle tables for org/user extensions: MCP servers (connectors), skills, agent definitions
// and custom commands. Mirrors migrations 001 and 003 (mcp_servers timestamps).
import { boolean, integer, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "../helpers/columns.helper.ts";

// ---------- tables ----------
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id").notNull(),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  /** Non-secret config (e.g. `{ url }`); secret headers live in `secrets` via `secret_id`. */
  config: jsonb<Record<string, unknown>>("config").notNull(),
  secretId: uuid("secret_id"),
  runsOn: text("runs_on").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
});

export const agentDefinitions = pgTable("agent_definitions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  mode: text("mode").notNull(),
  hidden: boolean("hidden").notNull().default(false),
  prompt: text("prompt").notNull(),
  permission: jsonb<unknown>("permission"),
  model: text("model"),
  tier: text("tier"),
  temperature: numeric("temperature", { mode: "number" }),
  steps: integer("steps"),
  options: jsonb<Record<string, unknown>>("options"),
  enabled: boolean("enabled").notNull().default(true),
});

export const commands = pgTable("commands", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  agent: text("agent"),
  model: text("model"),
  subtask: boolean("subtask").notNull().default(false),
  template: text("template").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});
