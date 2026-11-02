// A permission rule as written by an admin or user (before it gets an id).
import type { SettingScope } from "./subject.model.ts";

// ---------- types ----------
export interface NewRule {
  scope: SettingScope;
  scopeId: string;
  permission: string;
  pattern: string;
  action: string;
  locked?: boolean;
  priority?: number;
}
