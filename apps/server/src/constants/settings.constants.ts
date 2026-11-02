// Known settings keys with their defaults, and the order setting scopes layer in.

// ---------- constants ----------
/** Known settings with defaults. Unknown keys are allowed (stored as-is). */
export const SETTING_DEFAULTS: Record<string, unknown> = {
  "storage.mode": null, // null → per loop host: client=local, server=none
  "storage.allowed": ["none", "local", "server"],
  "models.default": "exa",
  "models.allowed": [],
  "byok.enabled": true,
  "pool.forDirect": false,
  "permission.mode": "default",
  "permission.bypassAllowed": false,
  "retention.contentDays": 30,
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
