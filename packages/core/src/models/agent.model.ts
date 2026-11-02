// Agents: a prompt + permission overrides + model preferences.
// primary = what the user talks to; subagent = delegated via the task tool (child session).

import type { PermissionRule, Tier } from "@exa/protocol";

// ---------- types ----------
export interface AgentDef {
  name: string;
  /** Routing hint: when to use it and what it cannot do. Required. */
  description: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  prompt: string;
  /** Agent-layer rules (appended after tenant/project/user rules). */
  rules: PermissionRule[];
  /** Model override; unset → session model (primary) or a fast-tier exa model (subagent). */
  model?: string;
  tier?: Tier;
  temperature?: number;
  steps?: number;
  /** Tools the agent never sees, regardless of permissions. */
  disabledTools?: string[];
  options?: Record<string, unknown>;
}
