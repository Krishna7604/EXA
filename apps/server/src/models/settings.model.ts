// Settings shapes: the layered result of resolving a subject's settings, and write targets.
import type { SettingScope } from "./subject.model.ts";

// ---------- types ----------
export interface ResolvedSettings {
  values: Record<string, unknown>;
  locked: Set<string>;
  /** Scope each value came from. */
  source: Record<string, SettingScope | "default">;
}

/** One setting key at one scope. */
export interface SettingTarget {
  scope: SettingScope;
  scopeId: string;
  key: string;
}

/** Optional extras for a setting write. */
export interface PutSettingOpts {
  locked?: boolean;
  by?: string;
}

/** One stored settings row, before layering. */
export interface SettingRow {
  scope: SettingScope;
  key: string;
  value: unknown;
  locked: boolean;
}
