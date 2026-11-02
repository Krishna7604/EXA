// Who a tenant-scoped config query is for, and the scopes settings/rules can live at.

// ---------- types ----------
export type SettingScope = "tenant" | "project" | "user";

export interface Subject {
  tenantId: string;
  userId: string;
  projectId?: string | null;
}
