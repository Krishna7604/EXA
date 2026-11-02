// Builds an agent-layer permission rule (shared by built-in and parsed agents).

import type { PermissionAction, PermissionRule } from "@exa/protocol";

// ---------- agent rule ----------
export function rule(
  permission: string,
  pattern: string,
  action: PermissionAction,
): PermissionRule {
  return { permission, pattern, action, scope: "agent" };
}
