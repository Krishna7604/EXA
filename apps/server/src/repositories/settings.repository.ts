// Layered settings (tenant < project < user). A tenant can lock a key so lower scopes can't
// override it.
import { type Db, settings } from "@exa/store";
import { and, eq, or, sql } from "drizzle-orm";
import { NO_PROJECT_ID } from "../constants/ids.constants.ts";
import { SCOPE_PRECEDENCE, SETTING_DEFAULTS } from "../constants/settings.constants.ts";
import type {
  PutSettingOpts,
  ResolvedSettings,
  SettingRow,
  SettingTarget,
} from "../models/settings.model.ts";
import type { SettingScope, Subject } from "../models/subject.model.ts";

// ---------- settings repo ----------
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async resolve(s: Subject): Promise<ResolvedSettings> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({
          scope: settings.scope,
          key: settings.key,
          value: settings.value,
          locked: settings.locked,
        })
        .from(settings)
        .where(
          or(
            and(eq(settings.scope, "tenant"), eq(settings.scopeId, s.tenantId)),
            and(eq(settings.scope, "user"), eq(settings.scopeId, s.userId)),
            and(eq(settings.scope, "project"), eq(settings.scopeId, s.projectId ?? NO_PROJECT_ID)),
          ),
        ),
    );
    return layerSettings(rows as SettingRow[]);
  }

  /** Throws if a higher scope locked the key. */
  async put(
    s: Subject,
    target: SettingTarget & { value: unknown },
    opts: PutSettingOpts = {},
  ): Promise<void> {
    const { scope, scopeId, key, value } = target;
    if (scope !== "tenant") await this.assertNotLocked(s, target);
    await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .insert(settings)
        .values({
          tenantId: s.tenantId,
          scope,
          scopeId,
          key,
          // Encoded here, not by the column, so a JSON null is stored as jsonb 'null'
          // (the column encoder would write SQL NULL into this NOT NULL column).
          value: sql`(${JSON.stringify(value)}::text)::jsonb`,
          locked: (opts.locked ?? false) && scope === "tenant",
          updatedBy: opts.by ?? null,
        })
        .onConflictDoUpdate({
          target: [settings.tenantId, settings.scope, settings.scopeId, settings.key],
          set: {
            value: sql`excluded.value`,
            locked: sql`excluded.locked`,
            updatedBy: sql`excluded.updated_by`,
            updatedAt: sql`now()`,
          },
        }),
    );
  }

  async delete(s: Subject, target: SettingTarget): Promise<void> {
    await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .delete(settings)
        .where(
          and(
            eq(settings.scope, target.scope),
            eq(settings.scopeId, target.scopeId),
            eq(settings.key, target.key),
          ),
        ),
    );
  }

  private async assertNotLocked(s: Subject, target: SettingTarget): Promise<void> {
    const projectId = target.scope === "project" ? target.scopeId : s.projectId;
    const cur = await this.resolve({ ...s, projectId });
    if (cur.locked.has(target.key) && cur.source[target.key] !== target.scope)
      throw new Error(`setting "${target.key}" is locked by your organization`);
  }
}

// ---------- helpers ----------
function layerSettings(rows: SettingRow[]): ResolvedSettings {
  const values: Record<string, unknown> = { ...SETTING_DEFAULTS };
  const source: Record<string, SettingScope | "default"> = Object.fromEntries(
    Object.keys(SETTING_DEFAULTS).map((k) => [k, "default" as const]),
  );
  const locked = new Set<string>();
  for (const scope of SCOPE_PRECEDENCE) {
    for (const r of rows.filter((x) => x.scope === scope)) {
      if (locked.has(r.key)) continue;
      values[r.key] = r.value;
      source[r.key] = scope;
      if (r.locked) locked.add(r.key);
    }
  }
  return { values, locked, source };
}
