// Org/user-scoped skill and agent definitions. AgentRow is shared with the CLI via @exa/store.
import type { AgentRow } from "@exa/store";

export type { AgentRow };

// ---------- types ----------
export type ExtensionScope = "tenant" | "user";

export interface SkillRow {
  id: string;
  scope: ExtensionScope;
  name: string;
  description: string;
  body: string;
  version: number;
}
