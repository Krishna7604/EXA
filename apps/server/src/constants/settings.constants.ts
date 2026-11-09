// Known settings keys with their defaults, and the order setting scopes layer in.

// ---------- constants ----------
/** Known settings with defaults. Unknown keys are allowed (stored as-is). */
export const SETTING_DEFAULTS: Record<string, unknown> = {
  // Every session's content is stored on the server unless the org or user picks otherwise.
  // null → per loop host: client=local, server=none.
  "storage.mode": "server",
  "storage.allowed": ["none", "local", "server"],
  "models.default": "exa",
  "models.allowed": [],
  "byok.enabled": true,
  "pool.forDirect": false,
  "permission.mode": "default",
  "permission.bypassAllowed": false,
  // Days to keep stored chat content; 0 keeps it forever (a personal agent's history).
  "retention.contentDays": 0,
  "sandbox.shell": false,
  // Server-loop (web) toolset: "chat" = agent with web/todo/skill/task but no filesystem,
  // "agent" = full coding agent inside a per-chat sandbox workspace.
  "web.tools": "chat",
  "subagent.maxDepth": 1,
  "loop.maxSteps": 50,
  "loop.maxCostUsd": 0,
};

/** Lowest precedence first: later scopes override earlier ones unless locked. */
export const SCOPE_PRECEDENCE = ["tenant", "project", "user"] as const;
