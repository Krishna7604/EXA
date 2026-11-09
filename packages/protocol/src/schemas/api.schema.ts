// HTTP request schemas (validated at the server edge with zod).

import { z } from "zod";

// Part of the `api` namespace since v1; the constant itself lives in constants/.
export { PROTOCOL_VERSION } from "../constants/protocol.constants.ts";

// ---------- constants ----------
const MODEL_NAME_MAX = 200;
const AGENT_NAME_MAX = 64;
const SESSION_TITLE_MAX = 300;
const DISPLAY_NAME_MAX = 120;
const TOOL_NAME_MAX = 128;
const PERMISSION_KEY_MAX = 64;
const TENANT_SLUG_PATTERN = /^[a-z0-9-]+$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MEMORY_TOPIC_MAX = 80;
const MEMORY_CONTENT_MAX = 2000;
const SEARCH_QUERY_MAX = 300;
const TASK_NAME_MAX = 120;
const TASK_PROMPT_MAX = 20_000;
const CRON_MAX = 120;
const TIMEZONE_MAX = 64;
const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE_MAX = 4096;

// ---------- shared enums ----------
export const StorageModeSchema = z.enum(["none", "local", "server"]);
export const LoopHostSchema = z.enum(["client", "server"]);
export const PermissionModeSchema = z.enum(["default", "accept-edits", "plan", "bypass"]);
export const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);

const TierSchema = z.enum(["fast", "balanced", "strong"]);

// ---------- auth ----------
export const DevLoginBody = z.object({
  email: z.string().email(),
  tenant: z.string().min(1).max(64).regex(TENANT_SLUG_PATTERN),
  name: z.string().max(DISPLAY_NAME_MAX).optional(),
});

export const TokenExchangeBody = z.object({ apiToken: z.string().min(10) });

export const OidcLoginBody = z.object({
  idToken: z.string().min(20),
  tenant: z.string().max(64).optional(),
});

export const DeviceApproveBody = z.object({ userCode: z.string().min(4).max(16) });
export const DevicePollBody = z.object({ deviceCode: z.string().min(16) });
export const DeviceStartBody = z.object({
  clientName: z.string().max(DISPLAY_NAME_MAX).default("exa-cli"),
});

// ---------- sessions ----------
export const CreateSessionBody = z.object({
  loopHost: LoopHostSchema,
  storageMode: StorageModeSchema.optional(),
  model: z.string().min(1).max(MODEL_NAME_MAX).optional(),
  agent: z.string().min(1).max(AGENT_NAME_MAX).optional(),
  projectId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  directory: z.string().max(4096).nullable().optional(),
  title: z.string().max(SESSION_TITLE_MAX).nullable().optional(),
  permissionMode: PermissionModeSchema.optional(),
});

export const PatchSessionBody = z.object({
  title: z.string().max(SESSION_TITLE_MAX).nullable().optional(),
  permissionMode: PermissionModeSchema.optional(),
  model: z.string().min(1).max(MODEL_NAME_MAX).optional(),
  agent: z.string().min(1).max(AGENT_NAME_MAX).optional(),
  archived: z.boolean().optional(),
});

export const PromptBody = z.object({
  text: z.string().min(1).max(500_000),
  agent: z.string().max(AGENT_NAME_MAX).optional(),
  model: z.string().max(MODEL_NAME_MAX).optional(),
});

export const PermissionReplyBody = z.object({ reply: z.enum(["once", "always", "reject"]) });

export const RevertBody = z.object({
  messageId: z.string().uuid(),
  partId: z.string().uuid().optional(),
});

// ---------- client loop ----------
export const LeaseBody = z.object({
  action: z.enum(["acquire", "renew", "release"]),
  fencing: z.number().int().nonnegative().optional(),
  ttlMs: z.number().int().min(5_000).max(600_000).optional(),
});

export const AuthorizeBody = z.object({
  sessionId: z.string().uuid(),
  tool: z.string().max(TOOL_NAME_MAX),
  permission: z.string().max(PERMISSION_KEY_MAX),
  patterns: z.array(z.string().max(8192)).max(256),
  input: z.unknown().optional(),
});

const ClientEventSchema = z.object({
  type: z.string(),
  v: z.number(),
  data: z.unknown(),
  time: z.number().optional(),
  sessionId: z.string().uuid().optional(),
});

const PersistedStepSchema = z.object({
  info: z.record(z.string(), z.unknown()),
  parts: z.array(z.record(z.string(), z.unknown())),
});

export const ClientEventsBody = z.object({
  fencing: z.number().int().nonnegative(),
  events: z.array(ClientEventSchema).max(2000),
  /** Final-state steps to store when the session's storage mode is "server". */
  persist: z.array(PersistedStepSchema).max(200).optional(),
});

// ---------- model gateway ----------
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), mime: z.string(), data: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    callId: z.string(),
    name: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
  }),
]);

const ModelMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentBlockSchema),
});

const ToolDefSchema = z.object({
  name: z.string().max(TOOL_NAME_MAX),
  description: z.string().max(20_000),
  parameters: z.record(z.string(), z.unknown()),
});

export const ModelRequestBody = z.object({
  model: z.string().min(1).max(MODEL_NAME_MAX),
  system: z.string().max(2_000_000),
  messages: z.array(ModelMessageSchema).max(5000),
  tools: z.array(ToolDefSchema).max(512).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tier: TierSchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().uuid().optional(),
});

// ---------- admin ----------
export const AddMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
});

export const PutQuotaBody = z.object({
  subjectScope: z.enum(["tenant", "user"]),
  subjectId: z.string().uuid().optional(),
  period: z.enum(["day", "month"]),
  maxTokens: z.number().int().positive().nullable().optional(),
  maxCostUsd: z.number().positive().nullable().optional(),
  maxRequests: z.number().int().positive().nullable().optional(),
});

export const PutSettingBody = z.object({
  scope: z.enum(["tenant", "project", "user"]),
  scopeId: z.string().uuid().optional(),
  key: z.string().min(1).max(128),
  value: z.unknown(),
  locked: z.boolean().optional(),
});

export const PutRuleBody = z.object({
  scope: z.enum(["tenant", "project", "user"]),
  scopeId: z.string().uuid().optional(),
  permission: z.string().min(1).max(PERMISSION_KEY_MAX),
  pattern: z.string().min(1).max(4096),
  action: PermissionActionSchema,
  locked: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export const PutProviderKeyBody = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(8).max(8192),
  scope: z.enum(["tenant", "user"]).default("user"),
  label: z.string().max(DISPLAY_NAME_MAX).optional(),
});

export const CreateApiTokenBody = z.object({
  name: z.string().max(DISPLAY_NAME_MAX).optional(),
  scopes: z.array(z.string()).default(["*"]),
  ttlDays: z.number().int().min(1).max(365).optional(),
});

// ---------- skills and agents ----------
export const PutSkillBody = z.object({
  scope: z.enum(["tenant", "user"]).default("user"),
  name: z.string().regex(SKILL_NAME_PATTERN).max(64),
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(200_000),
});

export const PutAgentBody = z.object({
  scope: z.enum(["tenant", "user"]).default("user"),
  name: z.string().regex(AGENT_NAME_PATTERN),
  description: z.string().min(1).max(2000),
  mode: z.enum(["primary", "subagent", "all"]).default("subagent"),
  hidden: z.boolean().default(false),
  prompt: z.string().min(1).max(100_000),
  permission: z.record(z.string(), PermissionActionSchema).nullable().default(null),
  model: z.string().max(MODEL_NAME_MAX).nullable().default(null),
  tier: TierSchema.nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  steps: z.number().int().min(1).max(500).nullable().default(null),
});

// ---------- memory ----------

/** Create a memory (POST) or replace one (PUT /v1/memories/:id). */
export const PutMemoryBody = z.object({
  topic: z.string().trim().min(1).max(MEMORY_TOPIC_MAX),
  content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX),
});

/** `?q=` for memory and chat search. */
export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ---------- scheduled tasks ----------

export const CreateTaskBody = z.object({
  name: z.string().trim().min(1).max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
  /** Five-field cron, e.g. "0 8 * * 1-5" (weekdays at 08:00). */
  schedule: z.string().trim().min(9).max(CRON_MAX),
  timezone: z.string().min(1).max(TIMEZONE_MAX).default("UTC"),
  model: z.string().min(1).max(MODEL_NAME_MAX).nullable().default(null),
  agent: z.string().min(1).max(AGENT_NAME_MAX).nullable().default(null),
  enabled: z.boolean().default(true),
});

export const PatchTaskBody = z.object({
  name: z.string().trim().min(1).max(TASK_NAME_MAX).optional(),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX).optional(),
  schedule: z.string().trim().min(9).max(CRON_MAX).optional(),
  timezone: z.string().min(1).max(TIMEZONE_MAX).optional(),
  model: z.string().min(1).max(MODEL_NAME_MAX).nullable().optional(),
  agent: z.string().min(1).max(AGENT_NAME_MAX).nullable().optional(),
  enabled: z.boolean().optional(),
});

// ---------- connectors (remote MCP servers) ----------

export const PutConnectorBody = z.object({
  scope: z.enum(["tenant", "user"]).default("user"),
  name: z.string().regex(CONNECTOR_NAME_PATTERN),
  url: z.string().url().max(2048),
  /** Sent on every request (e.g. Authorization). Stored encrypted; never returned. */
  headers: z
    .record(z.string().regex(HEADER_NAME_PATTERN), z.string().max(HEADER_VALUE_MAX))
    .default({}),
  enabled: z.boolean().default(true),
});

export const PatchConnectorBody = z.object({
  url: z.string().url().max(2048).optional(),
  /** Replaces all stored headers when present. */
  headers: z
    .record(z.string().regex(HEADER_NAME_PATTERN), z.string().max(HEADER_VALUE_MAX))
    .optional(),
  enabled: z.boolean().optional(),
});
